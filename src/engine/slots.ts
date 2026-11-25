/**
 * Slot contracts: what a component's slot takes, and how many. Insert, move, duplicate and paste check the slot
 * they put content in, and load validation checks every placement's slots, with the same rules.
 */
import type { ComponentDefinition, GraphNode, InstanceNode, NodeTree, ProjectState, SlotDef, SlotPrimitive } from '@shared/types';
import { COMPONENT_CATEGORIES, SLOT_PRIMITIVES } from '@shared/types';

/** Whether a slot limits what kinds of content it takes (beyond how many). */
export const restrictsKinds = (d: SlotDef): boolean => d.categories !== undefined || d.primitives !== undefined || d.componentIds !== undefined;

/** The most components a slot can name, and the longest name it can give one. */
export const SLOT_COMPONENT_IDS_MAX = 50;
const COMPONENT_ID_MAX = 120;

/** Whether a slot declared as `d` takes a placement of `def`: by its category, or named by its contract or definition ID. */
export function takesComponent(d: SlotDef, def: Pick<ComponentDefinition, 'id' | 'componentId' | 'category'>): boolean {
  if (!restrictsKinds(d)) return true;
  return (d.categories ?? []).includes(def.category) || (d.componentIds ?? []).some((id) => id === def.id || id === def.componentId);
}

/** The project's definitions a slot's component ID names: the one with that definition ID, else those of that contract. */
function namedDefinitions(state: Pick<ProjectState, 'components'> | undefined, id: string): ComponentDefinition[] {
  if (!state?.components) return [];
  if (Object.hasOwn(state.components, id)) return [state.components[id]];
  return Object.values(state.components).filter((c) => c?.componentId === id);
}

const PRIMITIVE_NAMES: Record<SlotPrimitive, [one: string, many: string]> = {
  element: ['a container', 'containers'],
  text: ['text', 'text'],
  image: ['an image', 'images'],
  link: ['a button', 'buttons'],
  icon: ['an icon', 'icons'],
  divider: ['a divider', 'dividers']
};

/**
 * "hero or media components, “Feature card”, text and images", or "anything", or "nothing". A component named by ID
 * is called by its name in `state` when the project has it, and by the ID otherwise.
 */
export function slotAccepts(d: SlotDef, state?: Pick<ProjectState, 'components'>): string {
  if (!restrictsKinds(d)) return 'anything';
  const named = [...new Set((d.componentIds ?? []).map((id) => `“${namedDefinitions(state, id)[0]?.name ?? id}”`))];
  const parts = [...(d.categories?.length ? [`${d.categories.join(' or ')} components`] : []), ...named, ...(d.primitives ?? []).map((p) => PRIMITIVE_NAMES[p]?.[1] ?? p)];
  if (!parts.length) return 'nothing';
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
}

export interface SlotFill {
  /** How many children the slot shows. A repeat, or a slot passed on from outside without a limit, can show any number. */
  count: number;
  /** The first child the slot does not take, and what it is, in words. */
  refused?: { nodeId: string; what: string };
  /** Every child the slot does not take, in order. */
  refusedAll: Array<{ nodeId: string; what: string }>;
}

const subset = <T>(a: readonly T[] | undefined, b: readonly T[] | undefined) => (a ?? []).every((x) => (b ?? []).includes(x));

/**
 * Whether every component `outer` names is one `decl` takes too: named there as well, or, when the project has it,
 * of a category `decl` takes (each of its definitions, when it names a contract several share).
 */
function namesTaken(state: Pick<ProjectState, 'components'>, outer: SlotDef, decl: SlotDef): boolean {
  return (outer.componentIds ?? []).every((id) => {
    if ((decl.componentIds ?? []).includes(id)) return true;
    const defs = namedDefinitions(state, id);
    return defs.length > 0 && defs.every((def) => takesComponent(decl, def));
  });
}

/**
 * What a list of children adds up to in a slot declared as `decl`. `design` is the definition the list sits in, when
 * the placement is part of a component's design: a slot passed on there brings whatever its own contract allows,
 * and a repeat shows its children once per item.
 */
export function slotFill(state: ProjectState, tree: NodeTree, ids: readonly string[], decl: SlotDef, design?: ComponentDefinition, seen = new Set<string>()): SlotFill {
  const kinds = restrictsKinds(decl);
  let count = 0;
  const refusedAll: SlotFill['refusedAll'] = [];
  const refuse = (nodeId: string, what: string) => void refusedAll.push({ nodeId, what });
  for (const id of ids) {
    const n: GraphNode | undefined = Object.hasOwn(tree.nodes, id) ? tree.nodes[id] : undefined;
    // A child that is missing, or listed under itself, is reported by the tree checks.
    if (!n || seen.has(id)) continue;
    if (n.kind === 'instance') {
      count++;
      const def = Object.hasOwn(state.components, n.definitionId) ? state.components[n.definitionId] : undefined;
      if (def && kinds && !takesComponent(decl, def)) refuse(id, `“${def.name}” (a ${def.category} component)`);
    } else if (n.kind === 'slot') {
      // Content passed on from the slot of the same name outside: it must be content this slot takes too.
      const outer = design?.slots && Object.hasOwn(design.slots, n.slot) ? design.slots[n.slot] : undefined;
      if (!outer) continue;
      count += outer.max ?? Infinity;
      if (kinds && (!restrictsKinds(outer) || !subset(outer.categories, decl.categories) || !subset(outer.primitives, decl.primitives) || !namesTaken(state, outer, decl)))
        refuse(id, `the content of “${outer.label}”, which can be ${slotAccepts(outer, state)}`);
    } else if (n.kind === 'repeat') {
      // A repeat shows its children once per item, and the items come from wherever the list is filled (a placement,
      // or an enclosing component that hands its own list on), so it can show any number.
      const inner = slotFill(state, tree, n.children, { ...decl, max: undefined }, design, new Set(seen).add(id));
      refusedAll.push(...inner.refusedAll);
      if (inner.count > 0) count = Infinity;
    } else {
      count++;
      if (kinds && !(decl.primitives ?? []).includes(n.kind)) refuse(id, PRIMITIVE_NAMES[n.kind][0]);
    }
  }
  return { count, ...(refusedAll.length ? { refused: refusedAll[0] } : {}), refusedAll };
}

/** The declared slot of a placement, if its component declares one by that name in a form it can enforce. */
export function slotDecl(state: ProjectState, inst: InstanceNode, slot: string): SlotDef | undefined {
  const def = Object.hasOwn(state.components, inst.definitionId) ? state.components[inst.definitionId] : undefined;
  const decl = def?.slots && Object.hasOwn(def.slots, slot) ? def.slots[slot] : undefined;
  // A contract damaged by hand is reported by validation (SLOT_INVALID); it decides nothing until it is fixed.
  return decl && !slotDeclProblem(decl) ? decl : undefined;
}

/**
 * Why putting `added` into a placement's slot breaks its contract, or null. The kinds of only the added children are
 * checked, and the limit only when the slot now shows more than `before` (what it showed before the edit), so content
 * already over the limit can still be reordered or taken out.
 */
export function slotLandingProblem(state: ProjectState, tree: NodeTree, inst: InstanceNode, slot: string, added: readonly string[], before: number, design?: ComponentDefinition): string | null {
  const decl = slotDecl(state, inst, slot);
  if (!decl) return null;
  const name = state.components[inst.definitionId]?.name ?? 'This component';
  const where = `The “${decl.label}” slot of “${name}”`;
  const refused = slotFill(state, tree, added, decl, design).refused;
  if (refused) return `${where} takes ${slotAccepts(decl, state)}, not ${refused.what}.`;
  if (decl.max === undefined) return null;
  const placed = inst.slots?.[slot];
  const count = slotFill(state, tree, Array.isArray(placed) ? placed : [], decl, design).count;
  // Content that can show any number is too many however much it showed before.
  if (count > decl.max && (count > before || count === Infinity)) return decl.max === 0 ? `${where} takes no content.` : `${where} holds at most ${decl.max === 1 ? 'one item' : `${decl.max} items`}${Number.isFinite(count) ? '' : ', and this can show any number'}.`;
  return null;
}

/** A slot declaration as written by a person, the AI or a pack, checked; the message names what is wrong. */
export function slotDeclProblem(d: unknown): string | null {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'is not a slot declaration';
  const r = d as Record<string, unknown>;
  if (typeof r.label !== 'string' || !r.label.trim()) return 'has no label';
  if (r.description !== undefined && typeof r.description !== 'string') return 'has a description that is not text';
  if (r.categories !== undefined && (!Array.isArray(r.categories) || r.categories.some((c) => !(COMPONENT_CATEGORIES as readonly unknown[]).includes(c))))
    return `lists categories other than ${COMPONENT_CATEGORIES.join(', ')}`;
  if (r.componentIds !== undefined && (!Array.isArray(r.componentIds) || r.componentIds.length > SLOT_COMPONENT_IDS_MAX || r.componentIds.some((c) => typeof c !== 'string' || !c.trim() || c.length > COMPONENT_ID_MAX)))
    return `names components by something other than up to ${SLOT_COMPONENT_IDS_MAX} component IDs`;
  if (r.primitives !== undefined && (!Array.isArray(r.primitives) || r.primitives.some((p) => !(SLOT_PRIMITIVES as readonly unknown[]).includes(p))))
    return `lists element kinds other than ${SLOT_PRIMITIVES.join(', ')}`;
  if (r.max !== undefined && !(typeof r.max === 'number' && Number.isInteger(r.max) && r.max >= 0 && r.max <= 1000)) return 'has a limit that is not a whole number from 0 to 1000';
  return null;
}
