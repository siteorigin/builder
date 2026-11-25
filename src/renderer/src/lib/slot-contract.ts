/**
 * A managed component's slots as Edit everywhere changes them: the places where each placement puts content of its
 * own, what each takes, and how many. Every helper plans operations; the engine checks them (component.setSlot,
 * component.removeSlot) and refuses a contract that content placements already hold no longer fits, naming where.
 */
import type { ComponentCategory, ComponentDefinition, ProjectState, SlotDef, SlotPrimitive } from '@shared/types';
import { COMPONENT_CATEGORIES, SLOT_PRIMITIVES, slotChildren } from '@shared/types';
import type { EditOperation, Op } from '@shared/ops';
import { instancesOf } from '@engine/tree';
import { restrictsKinds } from '@engine/slots';
import { toCodeName } from './prop-schema';
import { freeName, validPropName } from './component-contract';
import { insertOps, type InsertAt } from './insert-at';

/** The longest a slot's label and description can be, and its highest limit (see component.setSlot). */
export const SLOT_LABEL_MAX = 60;
export const SLOT_DESCRIPTION_MAX = 300;
export const SLOT_MAX_LIMIT = 1000;

/** Element kinds a slot can take, in words for a checkbox. */
export const SLOT_PRIMITIVE_LABELS: Record<SlotPrimitive, string> = { element: 'Containers', text: 'Text', image: 'Images', link: 'Buttons', icon: 'Icons', divider: 'Dividers' };

/** Component categories a slot can take, in words. The shared header and footer go in no slot, so they are not offered. */
export const SLOT_CATEGORY_LABELS: Partial<Record<ComponentCategory, string>> = {
  hero: 'Heroes',
  content: 'Content',
  'social-proof': 'Social proof',
  conversion: 'Conversion',
  media: 'Media',
  layout: 'Layout',
  primitive: 'Basics',
  custom: 'Your components'
};

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/** A slot the component declares, by name. */
export const declaredSlot = (def: ComponentDefinition, slot: string): SlotDef | undefined => own(def.slots, slot);

/**
 * Names a new slot must not take: the component's slots and properties, and every name a placement still keeps
 * content under, which a new slot by that name would show.
 */
export function takenSlotNames(state: ProjectState, def: ComponentDefinition): Set<string> {
  const out = new Set<string>([...Object.keys(def.slots ?? {}), ...Object.keys(def.properties)]);
  for (const { node } of instancesOf(state, def.id)) for (const k of Object.keys(node.slots ?? {})) out.add(k);
  return out;
}

/** The name a new slot labelled `label` is stored under: "Side panel" becomes sidePanel, or sidePanel2 when taken. */
export const newSlotName = (state: ProjectState, def: ComponentDefinition, label: string): string => freeName(toCodeName(label) ?? 'content', takenSlotNames(state, def), validPropName);

/** Where each slot shows in the design: its placeholder's node, by slot name, as the engine counts one placed. */
export function placedSlots(def: ComponentDefinition): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of Object.values(def.tree?.nodes ?? {})) if (n.kind === 'slot' && !out.has(n.slot)) out.set(n.slot, n.id);
  return out;
}

/** The slots the component declares that its design does not show yet, in the order it declares them. */
export const unplacedSlots = (def: ComponentDefinition): string[] => {
  const placed = placedSlots(def);
  return Object.keys(def.slots ?? {}).filter((name) => !placed.has(name));
};

/** Where a slot holds content: each placement with something in it, by the page or layout it is on. */
export const slotFilledIn = (state: ProjectState, def: ComponentDefinition, slot: string): string[] =>
  instancesOf(state, def.id)
    .filter((u) => slotChildren(u.node, slot).length > 0)
    .map((u) => u.label);

/**
 * A new slot, taking anything, with its placeholder at `at` in the design: declared and placed in one change (one
 * Undo). Null without a label.
 */
export function createSlotOps(state: ProjectState, def: ComponentDefinition, label: string, at: InsertAt): { slot: string; operations: EditOperation[] } | null {
  const text = label.trim().slice(0, SLOT_LABEL_MAX).trim();
  if (!text) return null;
  const slot = newSlotName(state, def, text);
  return { slot, operations: [{ type: 'component.setSlot', definitionId: def.id, slot, label: text }, ...insertOps(at, { primitive: 'slot', bind: slot }, 'element')] };
}

/** A slot's contract as its form edits it: what it takes is either anything or the kinds checked. */
export interface SlotDraft {
  label: string;
  description: string;
  /** Takes only the categories and kinds checked; otherwise anything. */
  restricted: boolean;
  categories: ComponentCategory[];
  primitives: SlotPrimitive[];
  /** The most it holds, as typed: blank for no limit. */
  max: string;
}

export function slotDraft(d: SlotDef): SlotDraft {
  return { label: d.label, description: d.description ?? '', restricted: restrictsKinds(d), categories: [...(d.categories ?? [])], primitives: [...(d.primitives ?? [])], max: d.max === undefined ? '' : String(d.max) };
}

/** Why a draft can't be saved, in words, or null when it can. */
export function slotDraftProblem(draft: SlotDraft): string | null {
  if (!draft.label.trim()) return 'Give the slot a name.';
  const max = draft.max.trim();
  if (max && (!/^\d+$/.test(max) || Number(max) > SLOT_MAX_LIMIT)) return `The most it holds is a whole number from 0 to ${SLOT_MAX_LIMIT}, or blank for no limit.`;
  return null;
}

const sameSet = (a: readonly string[], b: readonly string[]) => new Set(a).size === new Set(b).size && a.every((x) => b.includes(x));

/**
 * The change that gives slot `slot` the contract `draft` describes: its label, and only what else the draft changes,
 * so a field the author left alone keeps whatever it holds. Null when nothing changes, the draft can't be saved, or
 * the component no longer declares the slot (a save must never declare a removed slot again).
 */
export function editSlotOp(def: ComponentDefinition, slot: string, draft: SlotDraft): EditOperation | null {
  const d = declaredSlot(def, slot);
  if (!d || slotDraftProblem(draft)) return null;
  const op: Op<'component.setSlot'> = { type: 'component.setSlot', definitionId: def.id, slot, label: draft.label.trim().slice(0, SLOT_LABEL_MAX).trim() };
  let changed = op.label !== d.label;
  const description = draft.description.trim().slice(0, SLOT_DESCRIPTION_MAX);
  if (description !== (d.description ?? '')) {
    op.description = description || null;
    changed = true;
  }
  if (!draft.restricted) {
    if (d.categories !== undefined) op.categories = null;
    if (d.primitives !== undefined) op.primitives = null;
    changed ||= restrictsKinds(d);
  } else {
    // In the order the editor lists them, once each. A slot that took anything before is given both lists, so it
    // takes only what is checked, even nothing.
    const categories = COMPONENT_CATEGORIES.filter((c) => draft.categories.includes(c));
    const primitives = SLOT_PRIMITIVES.filter((p) => draft.primitives.includes(p));
    const was = restrictsKinds(d);
    if (!was || !sameSet(categories, d.categories ?? [])) {
      op.categories = categories;
      changed = true;
    }
    if (!was || !sameSet(primitives, d.primitives ?? [])) {
      op.primitives = primitives;
      changed = true;
    }
  }
  const max = draft.max.trim() === '' ? undefined : Number(draft.max.trim());
  if (max !== d.max) {
    op.max = max ?? null;
    changed = true;
  }
  return changed ? op : null;
}

/** Remove a slot and its placeholder; the engine refuses while any placement holds content in it, and names where. */
export const removeSlotOp = (def: ComponentDefinition, slot: string): EditOperation => ({ type: 'component.removeSlot', definitionId: def.id, slot });

/** How many children a slot holds, in words: "No limit", "Takes nothing", "At most 1". */
export const slotLimitWords = (d: SlotDef): string => (d.max === undefined ? 'No limit' : d.max === 0 ? 'Takes nothing' : `At most ${d.max}`);
