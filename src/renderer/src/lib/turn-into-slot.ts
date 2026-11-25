/**
 * Turn into slot… (#659): a container of a project component's design becomes a slot in one change, and so one Undo.
 * The container stays, with its layout and styles; what it holds either moves into every placement's new slot, each
 * keeping what it shows now, or goes, leaving the slot empty. Every helper plans the operation; the engine
 * (component.containerToSlot) checks it and refuses what it can't do safely, naming why.
 */
import type { ComponentDefinition, ElementRef, ProjectState } from '@shared/types';
import type { Op } from '@shared/ops';
import { applyOperations } from '@engine/apply';
import { containerToSlotProblem } from '@engine/container-to-slot';
import { dependentsOf } from '@engine/definitions';
import { instancesOf } from '@engine/tree';
import { blocksSaving, introducedDiagnostics, validateState } from '@engine/validate';
import { SLOT_LABEL_MAX, newSlotName } from './slot-contract';

export type SlotKeep = 'placements' | 'none';

const own = <T>(rec: Record<string, T> | undefined, key: string): T | undefined => (rec && Object.hasOwn(rec, key) ? rec[key] : undefined);

/**
 * Whether Turn into slot… is offered on `ref`, and why it can't act there: a container of a project component's design,
 * reached as the design's own node (Component Studio and Edit everywhere name it so), while the project can be edited.
 * Null where it isn't offered at all; `problem` says why a container can't become a slot, for a menu that shows the
 * command unavailable. Canvas, Layers and the inspector all ask this, so the command is offered on the same things.
 */
export function turnIntoSlotTarget(snap: { state: ProjectState; readOnly?: unknown } | null | undefined, ref: ElementRef | null): { ref: ElementRef; problem: string | null } | null {
  if (!snap || !ref || snap.readOnly || ref.owner.kind !== 'component' || ref.instancePath.length) return null;
  const def = own(snap.state.components, ref.owner.id);
  if (!def || def.owner !== 'project' || def.kind !== 'managed' || own(def.tree?.nodes, ref.nodeId)?.kind !== 'element') return null;
  return { ref: { owner: ref.owner, instancePath: [], nodeId: ref.nodeId }, problem: containerToSlotProblem(snap.state, def, ref.nodeId) };
}

/** The slot's name as the dialog starts it: the container's own name in Layers ("Side column"), else Content. */
export function defaultSlotLabel(def: ComponentDefinition, nodeId: string): string {
  const name = own(def.tree?.nodes, nodeId)?.name?.trim();
  return (name || 'Content').slice(0, SLOT_LABEL_MAX).trim();
}

/**
 * What the container holds now, and where it shows: how many children, how many placements would get them, and the
 * code components that render the component in their source (which a move can't reach, though they show it).
 */
export function turnIntoSlotScope(state: ProjectState, def: ComponentDefinition, nodeId: string): { children: number; placements: number; code: string[] } {
  const node = own(def.tree?.nodes, nodeId);
  return { children: node?.kind === 'element' ? node.children.length : 0, placements: instancesOf(state, def.id).length, code: dependentsOf(state, def.id).map((d) => d.name) };
}

/** The change, with the slot stored under a name of its own made from `label`; null without a label. */
export function turnIntoSlotOp(state: ProjectState, def: ComponentDefinition, nodeId: string, label: string, keep: SlotKeep): Op<'component.containerToSlot'> | null {
  const text = label.trim().slice(0, SLOT_LABEL_MAX).trim();
  if (!text) return null;
  return { type: 'component.containerToSlot', definitionId: def.id, nodeId, slot: newSlotName(state, def, text), label: text, keep };
}

/**
 * Why the change would be refused, or null when it lands: the operation tried on a copy of the project, then the
 * problems that would stop it from saving that it doesn't have now. The same check the project makes when the change
 * is applied, so the dialog can say why before the author confirms.
 */
export function turnIntoSlotPreflight(state: ProjectState, op: Op<'component.containerToSlot'>): string | null {
  let next: ProjectState;
  try {
    next = applyOperations(state, [op]).state;
  } catch (e) {
    return (e as Error).message;
  }
  try {
    const saving = (st: ProjectState) => validateState(st, { sectionLinks: false }).filter(blocksSaving);
    const introduced = introducedDiagnostics(saving(state), saving(next));
    return introduced.length ? introduced.map((d) => d.message).join(' ') : null;
  } catch {
    // A project these checks can't read is the project's own to refuse when the change is applied.
    return null;
  }
}

/**
 * The menu item for Turn into slot…, without its icon: it opens the dialog, or, where the container can't become a
 * slot, stays in the menu unavailable and says why.
 */
export function turnIntoSlotItem(target: { ref: ElementRef; problem: string | null }, open: (ref: ElementRef) => void): { label: string; disabled?: boolean; description?: string; ariaLabel?: string; onSelect?: () => void } {
  const label = 'Turn into slot…';
  return target.problem ? { label, disabled: true, description: target.problem, ariaLabel: label } : { label, onSelect: () => open(target.ref) };
}
