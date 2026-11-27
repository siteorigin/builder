/**
 * Named variant axes. A definition offers independent choices (tone, layout, ...), and a placement picks one
 * option on each, so tone and layout combine instead of multiplying into "dark-two-columns" style variants.
 */
import type { BindingRef, ComponentDefinition, InstanceNode, NodeTree, ProjectState, ResponsiveStyles, VariantAxis, VariantDef } from './types';
import { isBindingRef, isStateRef, stateInitial } from './types';
import { cascadeStyles, type StyleLayer } from './styles';

/** Axis and option IDs become generated identifiers and class names, so only plain ones are ever used. */
const AXIS_ID = /^[a-z][a-zA-Z0-9]{0,39}$/;
const OPTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,59}$/;

/**
 * A definition's usable axes, in document order, which is also the order they cascade in: a later axis wins a
 * property both set. An ID a hand-edited document made unusable is left out rather than generated.
 */
export function axesOf(def: Pick<ComponentDefinition, 'variantAxes'>): Array<[string, VariantAxis]> {
  const out: Array<[string, VariantAxis]> = [];
  for (const [axis, a] of Object.entries(def.variantAxes ?? {})) {
    if (!AXIS_ID.test(axis) || !a?.options) continue;
    const ids = Object.keys(a.options).filter((id) => OPTION_ID.test(id));
    if (!ids.length) continue;
    const options = ids.length === Object.keys(a.options).length ? a.options : Object.fromEntries(ids.map((id) => [id, a.options[id]]));
    out.push([axis, { ...a, options, default: ids.includes(a.default) ? a.default : ids[0] }]);
  }
  return out;
}

/** A name a code component can take an axis's option through: the form its properties' names take. */
const AXIS_PROP = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
/**
 * Names every code placement already passes for itself (`class`, a slot's `slot_<name>`, the `so_` plumbing), Svelte
 * keeps, or every object has (`toString`), which an omitted prop would still read.
 */
const placementOwn = (prop: string) => prop === 'class' || prop === 'children' || prop === 'slot' || prop.startsWith('so_') || prop.startsWith('slot_') || prop in Object.prototype;

/** What can be wrong with the property a code component's axis arrives in. */
export type CodeAxisProblemKind = 'missing' | 'name' | 'reserved' | 'property' | 'duplicate';

/**
 * What is wrong with the properties a code component's axes arrive in (`VariantAxis.prop`), axis by axis: one names
 * none, a name no property could have, one a placement already passes for itself, one of the component's own
 * properties, or one an earlier axis takes. Only usable axes count (see axesOf); managed components take none.
 */
export function codeAxisProblems(def: Pick<ComponentDefinition, 'kind' | 'variantAxes' | 'properties'>): Array<{ axis: string; kind: CodeAxisProblemKind; message: string }> {
  if (def.kind !== 'code') return [];
  const out: Array<{ axis: string; kind: CodeAxisProblemKind; message: string }> = [];
  const taken = new Map<string, string>();
  for (const [axis, a] of axesOf(def)) {
    const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim() : axis;
    const prop: unknown = a.prop;
    const problem: [CodeAxisProblemKind, string] | null =
      prop === undefined
        ? ['missing', 'names no property it arrives in (prop), so what placements choose never reaches the code']
        : typeof prop !== 'string' || !AXIS_PROP.test(prop)
          ? ['name', `arrives in “${String(prop)}”, which is not a property name: letters, numbers and underscores, starting with a letter`]
          : placementOwn(prop)
            ? ['reserved', `arrives in “${prop}”, a name every placement already passes for itself`]
            : Object.hasOwn(def.properties ?? {}, prop)
              ? ['property', `arrives in “${prop}”, which is also one of the component's properties`]
              : taken.has(prop)
                ? ['duplicate', `arrives in “${prop}”, as the “${taken.get(prop)}” axis does`]
                : null;
    if (problem) out.push({ axis, kind: problem[0], message: `the “${label}” variant axis ${problem[1]}.` });
    if (typeof prop === 'string' && !taken.has(prop)) taken.set(prop, label);
  }
  return out;
}

/** The property each axis of a code component arrives in, in axis order: only the axes whose prop is sound (codeAxisProblems). */
export function codeAxisProps(def: Pick<ComponentDefinition, 'kind' | 'variantAxes' | 'properties'>): Array<[axis: string, prop: string]> {
  if (def.kind !== 'code') return [];
  const bad = new Set(codeAxisProblems(def).map((p) => p.axis));
  return axesOf(def).flatMap(([axis, a]) => (bad.has(axis) || typeof a.prop !== 'string' ? [] : [[axis, a.prop] as [string, string]]));
}

/** Whether every axis and option ID in the document is one the generator can use. */
export function variantIdsValid(def: Pick<ComponentDefinition, 'variantAxes'>): boolean {
  return Object.entries(def.variantAxes ?? {}).every(([axis, a]) => AXIS_ID.test(axis) && Object.keys(a?.options ?? {}).every((id) => OPTION_ID.test(id)));
}

/** Every option of every axis. */
export function variantOptions(def: Pick<ComponentDefinition, 'variantAxes'>): Array<{ axis: string; id: string; option: VariantDef }> {
  return axesOf(def).flatMap(([axis, a]) => Object.entries(a.options).map(([id, option]) => ({ axis, id, option })));
}

/** What a placement shows on each axis: its own choice where that is a real option, otherwise the axis default. */
export function selectedVariants(def: Pick<ComponentDefinition, 'variantAxes'>, chosen: InstanceNode['variants']): Record<string, string | BindingRef> {
  const out: Record<string, string | BindingRef> = {};
  for (const [axis, a] of axesOf(def)) {
    const v = chosen && Object.hasOwn(chosen, axis) ? chosen[axis] : undefined;
    out[axis] = isBindingRef(v) ? v : typeof v === 'string' && Object.hasOwn(a.options, v) ? v : a.default;
  }
  return out;
}

/**
 * A placement's choices with each axis bound to its design's UI state (`owner`, the design it is placed in) replaced
 * by the option the state starts at, which is what the generated site shows. Other bound axes stay bound.
 */
export function startingVariants(chosen: InstanceNode['variants'], owner: Pick<ComponentDefinition, 'state'> | undefined): InstanceNode['variants'] {
  if (!chosen || !owner?.state) return chosen;
  let out = chosen;
  for (const [axis, v] of Object.entries(chosen)) {
    const start = isStateRef(v) ? stateInitial(owner, v.$state) : undefined;
    if (typeof start === 'string') out = { ...out, [axis]: start };
  }
  return out;
}

/** The style rules the selected options set on one node, in axis order. A bound axis counts as its default. */
export function selectedVariantStyles(def: Pick<ComponentDefinition, 'variantAxes'>, chosen: InstanceNode['variants'], nodeId: string): ResponsiveStyles[] {
  const selected = selectedVariants(def, chosen);
  const out: ResponsiveStyles[] = [];
  for (const [axis, a] of axesOf(def)) {
    const v = selected[axis];
    const styles = a.options[typeof v === 'string' ? v : a.default]?.styles?.[nodeId];
    if (styles) out.push(styles);
  }
  return out;
}

/**
 * What a component's design gives one of its nodes at each size: the node's own styles, then the selected options'
 * styles, cascaded as the generated stylesheet does (a variant rule carries one more class than a node rule, so it
 * wins at every size). A placement's own changes come on top of this.
 */
export function designStyles(def: Pick<ComponentDefinition, 'variantAxes' | 'tree'>, nodeId: string, chosen: InstanceNode['variants']): ResponsiveStyles {
  return cascadeStyles(designLayers(def, nodeId, chosen));
}

/** The style layers `designStyles` cascades, weakest first, for callers that add stronger layers on top. */
export function designLayers(def: Pick<ComponentDefinition, 'variantAxes' | 'tree'>, nodeId: string, chosen: InstanceNode['variants']): StyleLayer[] {
  const own = def.tree?.nodes[nodeId]?.styles;
  const selected = selectedVariants(def, chosen);
  const axes = axesOf(def);
  const layers: StyleLayer[] = [{ styles: own, strength: 1 }];
  axes.forEach(([axis, a], index) => {
    const v = selected[axis];
    const styles = a.options[typeof v === 'string' ? v : a.default]?.styles?.[nodeId];
    if (!styles) return;
    // Showing the node again undoes a hide in its own styles or in any option of an earlier axis, as the stylesheet
    // writes it whichever of those options is chosen.
    const earlier = axes.slice(0, index).flatMap(([, x]) => Object.values(x.options).map((o) => o.styles?.[nodeId]));
    layers.push({ styles, strength: 2, wideColumns: true, unhides: [own, ...earlier] });
  });
  return layers;
}

function describe(def: ComponentDefinition): string {
  return axesOf(def).map(([axis, a]) => `${axis}: ${Object.keys(a.options).join(', ')}`).join('; ') || 'none';
}

/**
 * Find an option by ID, on the named axis or on whichever axis has it. "default" exists on most axes and always
 * means the first; any other ID on several axes must name one.
 */
export function findVariant(def: ComponentDefinition, id: string, axis?: string): { axis: string; id: string } | { error: string } {
  if (axis !== undefined) {
    const a = axesOf(def).find(([name]) => name === axis)?.[1];
    if (!a) return { error: `"${def.name}" has no variant axis "${axis}". Variants: ${describe(def)}.` };
    if (!Object.hasOwn(a.options, id)) return { error: `"${def.name}" has no ${axis} "${id}". Variants: ${describe(def)}.` };
    return { axis, id };
  }
  const matches = axesOf(def).filter(([, a]) => Object.hasOwn(a.options, id));
  if (!matches.length) return { error: `"${def.name}" has no variant "${id}". Variants: ${describe(def)}.` };
  if (matches.length > 1 && id !== 'default') return { error: `"${id}" is on several variant axes of "${def.name}" (${matches.map(([a]) => a).join(', ')}). Name the axis.` };
  return { axis: matches[0][0], id };
}

/** Every tree that places components, keyed by its owner, with a name for messages. */
function placingTrees(state: ProjectState): Map<string, { label: string; tree: NodeTree }> {
  const out = new Map<string, { label: string; tree: NodeTree }>();
  out.set('shell:header', { label: 'The header', tree: state.site.shell.header });
  out.set('shell:footer', { label: 'The footer', tree: state.site.shell.footer });
  for (const page of Object.values(state.pages)) out.set(`page:${page.id}`, { label: `The “${page.title}” page`, tree: page });
  for (const def of Object.values(state.components)) if (def.tree) out.set(`component:${def.id}`, { label: `“${def.name}”`, tree: def.tree });
  return out;
}

const offers = (def: ComponentDefinition | undefined, axis: string, option: string) => !!def && axesOf(def).some(([a, x]) => a === axis && Object.hasOwn(x.options, option));

/**
 * Choices that a change of definitions alone leaves naming nothing: a placement keeps its own option, which its
 * definition offered before, but no longer offers (a component file put back from an older copy, say). The
 * placement would quietly show the default instead. A placement whose own choice changed is not counted, nor one in a
 * document `skip` names by owner ("page:<id>", "shell:header", "component:<id>").
 */
export function choicesLost(before: ProjectState, after: ProjectState, skip: (owner: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const was = placingTrees(before);
  for (const [key, { label, tree }] of placingTrees(after)) {
    const old = was.get(key)?.tree;
    if (!old || skip(key)) continue;
    for (const node of Object.values(tree.nodes)) {
      if (node.kind !== 'instance' || !node.variants) continue;
      const prev = Object.hasOwn(old.nodes, node.id) ? old.nodes[node.id] : undefined;
      if (prev?.kind !== 'instance' || prev.definitionId !== node.definitionId || !prev.variants) continue;
      const def = after.components[node.definitionId];
      for (const [axis, option] of Object.entries(node.variants)) {
        if (typeof option !== 'string' || !Object.hasOwn(prev.variants, axis) || prev.variants[axis] !== option) continue;
        if (offers(before.components[node.definitionId], axis, option) && !offers(def, axis, option))
          out.push(`${label} uses the ${axis} “${option}” of “${def?.name ?? node.definitionId}”, which the changed component no longer has.`);
      }
    }
  }
  return out;
}
