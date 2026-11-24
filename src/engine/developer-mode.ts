/**
 * What needs Developer mode: working with Svelte source, and anything that makes a new code component by copying
 * one (a duplicate, a placement made unique, a theme component edited everywhere). One check for every way into
 * the project, so a change refused in the Inspector is refused to the AI too.
 */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import type { EditOperation, OperationType } from '@shared/ops';
import { getTheme } from '@catalogue/index';
import { applyOperation } from './apply';
import { getTree } from './tree';

/** Operations that work with source directly. */
export const CODE_OPERATIONS = new Set<OperationType>(['component.createCode', 'component.updateSource', 'component.convertToCode']);
/** Operations that copy a definition, which makes new code when the definition is code. */
const COPIES = new Set<OperationType>(['component.duplicate', 'component.makeUnique', 'component.fork']);

/** A definition in the project, or one of the active theme's that an operation would install. */
function definition(state: ProjectState, id: string): ComponentDefinition | undefined {
  if (Object.hasOwn(state.components, id)) return state.components[id];
  return getTheme(state.site.themeId).components.find((d) => d.id === id);
}

/** Why one operation needs Developer mode in the project as it is, or null when it does not. */
export function developerModeReason(state: ProjectState, op: EditOperation): string | null {
  if (CODE_OPERATIONS.has(op.type)) return 'Custom code needs Developer mode.';
  let def: ComponentDefinition | undefined;
  let what = '';
  if (op.type === 'component.duplicate') {
    def = definition(state, op.definitionId);
    what = 'Duplicating it';
  } else if (op.type === 'component.fork') {
    def = definition(state, op.definitionId);
    // A project's own definition is already its own: forking it copies nothing.
    if (def?.owner === 'project') return null;
    what = 'Editing it everywhere';
  } else if (op.type === 'component.makeUnique') {
    try {
      const n = getTree(state, op.owner).nodes[op.nodeId];
      def = n?.kind === 'instance' ? state.components[n.definitionId] : undefined;
    } catch {
      return null;
    }
    what = 'Making this placement unique';
  }
  if (def?.kind !== 'code') return null;
  return `“${def.name}” is a code component. ${what} copies its Svelte source into a new code component, which needs Developer mode.`;
}

/**
 * Why a batch needs Developer mode, or null. Each operation is checked against the project as the operations before
 * it leave it, so a theme switched or a component installed earlier in the same batch is the one a later copy copies.
 */
export function developerModeRefusal(state: ProjectState, ops: EditOperation[]): string | null {
  if (!ops.some((o) => CODE_OPERATIONS.has(o.type) || COPIES.has(o.type))) return null;
  let draft: ProjectState | null = null;
  for (const [i, op] of ops.entries()) {
    const reason = developerModeReason(draft ?? state, op);
    if (reason) return reason;
    // Staged only while a later operation copies something.
    if (!ops.slice(i + 1).some((o) => COPIES.has(o.type))) break;
    draft ??= structuredClone(state);
    try {
      applyOperation(draft, op);
    } catch {
      // The batch is refused at this operation anyway; later ones are still checked against what came before it.
    }
  }
  return null;
}
