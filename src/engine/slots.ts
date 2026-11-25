/**
 * Slot contracts: what a component's slot takes, and how many. Insert, move, duplicate and paste check the slot
 * they put content in, and load validation checks every placement's slots, with the same rules.
 */
import type { ComponentDefinition, GraphNode, InstanceNode, NodeTree, ProjectState, SlotDef, SlotPrimitive } from '@shared/types';
import { COMPONENT_CATEGORIES, SLOT_PRIMITIVES, slotFallback } from '@shared/types';
import { findParent } from './tree';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

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
 * Whether every component `outer` names is one `decl` takes too: named there as well, or, for a definition the
 * project has named by its own ID, taken by `decl` by its category or contract. A contract stands for any theme's
 * design of it, whatever the project has installed today, so only a slot naming that contract too takes it.
 */
function namesTaken(state: Pick<ProjectState, 'components'>, outer: SlotDef, decl: SlotDef): boolean {
  return (outer.componentIds ?? []).every((id) => {
    if ((decl.componentIds ?? []).includes(id)) return true;
    const def = state.components && Object.hasOwn(state.components, id) ? state.components[id] : undefined;
    return !!def && takesComponent(decl, def);
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
      // Content passed on from the slot of the same name outside: it must be content this slot takes too. While the
      // placement outside leaves that slot empty, the design's own fallback for it shows here instead: that too.
      const fallback = slotFallback(n);
      const shown = fallback.length ? slotFill(state, tree, fallback, { ...decl, max: undefined }, design, new Set(seen).add(id)) : undefined;
      if (shown) refusedAll.push(...shown.refusedAll);
      // A contract damaged by hand decides nothing until it is fixed (validation reports it).
      const declared = design?.slots && Object.hasOwn(design.slots, n.slot) ? design.slots[n.slot] : undefined;
      const outer = declared && !slotDeclProblem(declared) ? declared : undefined;
      if (!outer) {
        count += shown?.count ?? 0;
        continue;
      }
      // Only one of the two shows at a time.
      count += Math.max(outer.max ?? Infinity, shown?.count ?? 0);
      // A slot closed to content never brings any.
      if (kinds && outer.max !== 0 && (!restrictsKinds(outer) || !subset(outer.categories, decl.categories) || !subset(outer.primitives, decl.primitives) || !namesTaken(state, outer, decl)))
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

/** How often what is put in a slot shows: not at all, once, or MANY (more than once, or a number no one can tell). */
const MANY = 2;

/**
 * The slots a component's design shows exactly once, so what is put in one shows once: through its own elements, or
 * handed to a component placed in it that shows it once itself; not inside a repeat (once per item, or never), nor from
 * two places. In the order it declares them. A code component renders its slots as its code likes, so none counts.
 */
export function shownOnceSlots(state: ProjectState, definitionId: string): string[] {
  const counts = slotCounts(state, definitionId, new Map(), new Set());
  return Object.keys(own(state.components, definitionId)?.slots ?? {}).filter((name) => counts.get(name) === 1);
}

/**
 * How often `definitionId`'s design shows each of its slots (0, 1 or MANY). Each definition is worked out once per
 * question (`done`), so a design that places another twice, which places another twice, costs no more than its parts;
 * one placed inside itself (`path`) shows its slots MANY times.
 */
function slotCounts(state: ProjectState, definitionId: string, done: Map<string, Map<string, number>>, path: ReadonlySet<string>): Map<string, number> {
  const known = done.get(definitionId);
  if (known) return known;
  const def = own(state.components, definitionId);
  const counts = new Map<string, number>();
  if (!def) return counts;
  if (def.kind !== 'managed' || !def.tree || path.has(def.id)) {
    for (const name of Object.keys(def.slots ?? {})) counts.set(name, MANY);
    return counts;
  }
  const tree = def.tree;
  const within = new Set(path).add(def.id);
  const seen = new Set<string>();
  const walk = (id: string, times: number) => {
    const n = own(tree.nodes, id);
    if (!n || !times || seen.has(id)) return;
    seen.add(id);
    // An outlet for a slot it no longer declares is given nothing (the generator passes declared slots only).
    if (n.kind === 'slot') {
      if (Object.hasOwn(def.slots ?? {}, n.slot)) counts.set(n.slot, Math.min(MANY, (counts.get(n.slot) ?? 0) + times));
      // Its fallback shows only while that slot is left empty, so an outlet in it shows a number no one can tell.
      slotFallback(n).forEach((c) => walk(c, MANY));
    }
    else if (n.kind === 'element') n.children.forEach((c) => walk(c, times));
    else if (n.kind === 'repeat') n.children.forEach((c) => walk(c, MANY));
    else if (n.kind === 'instance') {
      // What the design hands a component placed in it shows as often as that component shows the slot it fills.
      const fills = Object.entries(n.slots ?? {}).filter(([, ids]) => Array.isArray(ids) && ids.length);
      if (!fills.length) return;
      const inner = slotCounts(state, n.definitionId, done, within);
      for (const [slot, ids] of fills) ids.forEach((c) => walk(c, Math.min(MANY, times * (inner.get(slot) ?? 0))));
    }
  };
  tree.rootIds.forEach((id) => walk(id, 1));
  done.set(def.id, counts);
  return counts;
}

/**
 * Whether a node of a design shows once wherever the design does: it hangs from the design's root, no repeat holds it,
 * and every component it sits in shows the slot it sits in once.
 */
export function shownOnceIn(state: ProjectState, tree: NodeTree, nodeId: string): boolean {
  const seen = new Set<string>();
  for (let id = nodeId; ; ) {
    const at = findParent(tree, id);
    // Nothing holds it: left over in the design, never shown.
    if (!at) return false;
    if (at.parentId === null) return true;
    if (seen.has(at.parentId)) return false;
    seen.add(at.parentId);
    const parent = own(tree.nodes, at.parentId);
    if (!parent || parent.kind === 'repeat') return false;
    if (parent.kind === 'instance' && !(at.slot && shownOnceSlots(state, parent.definitionId).includes(at.slot))) return false;
    id = at.parentId;
  }
}
