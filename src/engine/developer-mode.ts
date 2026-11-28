/**
 * What needs Developer mode: working with Svelte source, and anything that makes a new code component by copying
 * one (a duplicate, a placement made unique, a theme component edited everywhere). One check for every way into
 * the project, so a change refused in the Inspector is refused to the AI too.
 */
import type { ComponentDefinition, ProjectState } from '@shared/types';
import type { EditOperation, OperationType } from '@shared/ops';
import { getTheme } from '@catalogue/index';
import { walkOperations, type ApplyContext } from './apply';
import { getTree } from './tree';
import { importedCode } from './component-package';

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
    // A project's own definition is already its own: forking all of it copies nothing. Some placements get a copy.
    if (def?.owner === 'project' && !op.placements) return null;
    what = op.placements ? 'Copying it for these placements' : 'Editing it everywhere';
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
 * Why a batch needs Developer mode, or null. Source operations need it wherever they are. A copy is checked against the
 * project as the operations before it leave it, applied as the engine applies them, so a theme switched or a component
 * installed earlier in the same batch is the one it copies.
 */
export function developerModeRefusal(state: ProjectState, ops: EditOperation[], ctx: ApplyContext = {}): string | null {
  const step = developerModeCheck(state, ops, ctx);
  // `ctx` is the context the batch will apply with (the editor's clipboard), so a paste stages as it will land.
  return typeof step === 'function' ? walkOperations(state, ops, step, ctx) : step;
}

/**
 * `developerModeRefusal` without its walk: the reason (or null) when no walk is needed to know it, otherwise what to ask
 * of each operation in a walk of the batch (walkChecks), with the same `ctx`.
 */
export function developerModeCheck(state: ProjectState, ops: EditOperation[], ctx: ApplyContext = {}): string | null | ((draft: ProjectState, op: EditOperation) => string | null) {
  if (ops.some((o) => CODE_OPERATIONS.has(o.type))) return developerModeReason(state, ops.find((o) => CODE_OPERATIONS.has(o.type))!);
  // A package brings its code components with it: new code in the project, however it arrives.
  const code = ops.some((o) => o.type === 'component.import') && ctx.componentImport ? importedCode(state, ctx.componentImport) : [];
  if (code.length) return `The package includes ${code.length === 1 ? `the code component “${code[0].name}”` : `${code.length} code components`}, which ${code.length === 1 ? 'needs' : 'need'} Developer mode.`;
  if (!ops.some((o) => COPIES.has(o.type))) return null;
  return (draft, op) => (COPIES.has(op.type) ? developerModeReason(draft, op) : null);
}

/**
 * An answer that says what was asked needs Developer mode, as the assistant is told to say it: with it off, the turn
 * offers Settings at its switch (#1329). One that only mentions it ("built with Developer mode off") offers nothing.
 */
export const SAYS_DEVELOPER_MODE = /(?<!(?:\bnot|n['’]t|\bnever)\s+)\b(?:needs?|requires?|required|needed)\s+(?:\*\*|_)?Developer mode\b|(?<!\bno\s+)\bDeveloper mode(?:\*\*|_)?\s+(?:is\s+)?(?:required|needed)\b/i;
