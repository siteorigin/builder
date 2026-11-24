/**
 * Named variant axes. A definition offers independent choices (tone, layout, ...), and a placement picks one
 * option on each, so tone and layout combine instead of multiplying into "dark-two-columns" style variants.
 */
import type { Bindable, ComponentDefinition, InstanceNode, NodeTree, ProjectState, ResponsiveStyles, VariantAxis, VariantDef } from './types';
import { isBinding } from './types';
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

/** Whether every axis and option ID in the document is one the generator can use. */
export function variantIdsValid(def: Pick<ComponentDefinition, 'variantAxes'>): boolean {
  return Object.entries(def.variantAxes ?? {}).every(([axis, a]) => AXIS_ID.test(axis) && Object.keys(a?.options ?? {}).every((id) => OPTION_ID.test(id)));
}

/** Every option of every axis. */
export function variantOptions(def: Pick<ComponentDefinition, 'variantAxes'>): Array<{ axis: string; id: string; option: VariantDef }> {
  return axesOf(def).flatMap(([axis, a]) => Object.entries(a.options).map(([id, option]) => ({ axis, id, option })));
}

/** What a placement shows on each axis: its own choice where that is a real option, otherwise the axis default. */
export function selectedVariants(def: Pick<ComponentDefinition, 'variantAxes'>, chosen: InstanceNode['variants']): Record<string, Bindable<string>> {
  const out: Record<string, Bindable<string>> = {};
  for (const [axis, a] of axesOf(def)) {
    const v = chosen && Object.hasOwn(chosen, axis) ? chosen[axis] : undefined;
    out[axis] = isBinding(v) ? v : typeof v === 'string' && Object.hasOwn(a.options, v) ? v : a.default;
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
