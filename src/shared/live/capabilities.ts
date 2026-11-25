import { z } from 'zod';
import type { BuilderApi } from '../api';
import type { ElementRef } from '../types';
import { validateOperation, type EditOperation, type OperationType, type ToolErrorCode } from '../ops';
import type { GuestRole } from './limits';
import type { Presence, RpcError, RpcErrorCode } from './messages';

/**
 * What each guest role may do, checked by the host before anything runs: deny by default. Only the methods and
 * operations listed here are ever allowed; a method or operation added to the app later stays refused for guests
 * until it is listed. Everything the host alone may do (opening, closing, exporting or revealing projects, file
 * dialogs, settings, API keys, AI, source code, versions, conflicts and history) appears in no list.
 */

type ProjectMethod = `project.${keyof BuilderApi['project'] & string}`;

/** A viewer reads the project as it is now; the preview, presence and the editor events come with admission. */
export const VIEWER_METHODS = ['project.snapshot'] as const satisfies readonly ProjectMethod[];
/** A collaborator also makes visual edits. */
export const COLLABORATOR_METHODS = [...VIEWER_METHODS, 'project.apply'] as const satisfies readonly ProjectMethod[];
export type LiveMethod = (typeof COLLABORATOR_METHODS)[number];

const METHODS: Record<GuestRole, readonly string[]> = { viewer: VIEWER_METHODS, collaborator: COLLABORATOR_METHODS };

/** Whether a guest holding `role` may call the dotted `BuilderApi` method. Unknown names are refused. */
export function canCall(role: GuestRole, method: string): method is LiveMethod {
  return Object.hasOwn(METHODS, role) && METHODS[role].includes(method);
}

/**
 * The edits a collaborator may make: page structure, the content, styles and layout of what is on a page, placements
 * of components already in the project (detaching one into the page), and the site's style tokens. Everything else
 * is refused: code (writing source, converting to code, and forking, duplicating or making unique the copies that can
 * carry source), component definitions and theme installs, imports, site settings and the project brief, redirects,
 * collections and their entries, the asset library, and pasting from a host clipboard a guest cannot fill.
 */
export const COLLABORATOR_OPERATIONS = [
  'page.create',
  'page.update',
  'page.duplicate',
  'page.reorder',
  'page.remove',
  'page.setHome',
  'node.insert',
  'node.remove',
  'node.removeKeepContent',
  'node.move',
  'node.wrap',
  'node.unwrap',
  'node.duplicate',
  'node.copy',
  'node.rename',
  'node.setStyle',
  'node.resetStyles',
  'node.setContent',
  'node.setBinding',
  'node.setStateAction',
  'instance.setProp',
  'instance.listInsert',
  'instance.listRemove',
  'instance.listMove',
  'instance.editTable',
  'instance.setVariant',
  'instance.swapComponent',
  'token.set',
  'token.setColorScheme',
  'token.create',
  'token.rename',
  'token.remove',
  'token.replace',
  'component.detachInstance'
] as const satisfies readonly OperationType[];

const OPERATIONS: Record<GuestRole, readonly string[]> = { viewer: [], collaborator: COLLABORATOR_OPERATIONS };

/** Whether a guest holding `role` may make an edit of this operation type. Viewers make none. */
export function canEditOperation(role: GuestRole, type: string): boolean {
  return Object.hasOwn(OPERATIONS, role) && OPERATIONS[role].includes(type);
}

export const LIVE_BATCH_MAX_OPERATIONS = 256;
export const LIVE_BATCH_LABEL_MAX = 120;

/**
 * A guest's batch of edits, as it travels: operations and the revision they were made against. The host attaches
 * the opening and history label itself, naming the guest; a guest never chooses which project or entry it edits.
 */
export interface LiveEditBatch {
  operations: EditOperation[];
  expectedRevision?: number;
  label?: string;
}
// A guest's batch is always one the local pipeline accepts as it is.
const _liveBatchIsEditBatch: Parameters<BuilderApi['project']['apply']>[0] = {} as LiveEditBatch;
void _liveBatchIsEditBatch;
// Every refusal the engine gives can be passed on to a guest as it is.
const _everyEngineCode: Exclude<ToolErrorCode, RpcErrorCode> extends never ? true : never = true;
void _everyEngineCode;
// Presence selections are the editor's own element references. messages.ts keeps its own copy so the relay never
// reads the app's types; this keeps the two the same.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _selectionIsElementRef: Same<NonNullable<Presence['selection']>, ElementRef> = true;
void _selectionIsElementRef;

const BATCH = z
  .object({
    operations: z.array(z.unknown()).min(1).max(LIVE_BATCH_MAX_OPERATIONS),
    expectedRevision: z.number().int().nonnegative().optional(),
    label: z.string().max(LIVE_BATCH_LABEL_MAX).optional()
  })
  .strict();

export type CapabilityResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

const denied = (message: string, operationIndex?: number): { ok: false; error: RpcError } => ({ ok: false, error: { code: 'PERMISSION_DENIED', message, recoverable: false, ...(operationIndex !== undefined ? { operationIndex } : {}) } });
const invalid = (message: string, operationIndex?: number): { ok: false; error: RpcError } => ({ ok: false, error: { code: 'INVALID_ARGUMENT', message: message.slice(0, 500), recoverable: false, ...(operationIndex !== undefined ? { operationIndex } : {}) } });

/**
 * Check a guest's batch before any of it runs: its shape, then each operation's type against the role, then the
 * operation itself, as the local pipeline validates it. One refused operation refuses the whole batch, naming it.
 * Only the parsed operations come back, so what runs is exactly what was checked.
 */
export function checkEditBatch(role: GuestRole, input: unknown): CapabilityResult<LiveEditBatch> {
  if (!canCall(role, 'project.apply')) return denied('Only collaborators can edit this project.');
  const batch = BATCH.safeParse(input);
  if (!batch.success) {
    const issue = batch.error.issues[0];
    return invalid(`${issue.path.map(String).join('.') || 'batch'}: ${issue.message}`);
  }
  const operations: EditOperation[] = [];
  for (const [index, raw] of batch.data.operations.entries()) {
    const type = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { type?: unknown }).type : undefined;
    if (typeof type !== 'string') return invalid('Each operation needs a type.', index);
    if (!canEditOperation(role, type)) return denied(`A ${role} cannot make "${type.slice(0, 60)}" edits.`, index);
    const checked = validateOperation(raw);
    if (!checked.ok) return invalid(checked.message, index);
    operations.push(checked.op);
  }
  const { expectedRevision, label } = batch.data;
  return { ok: true, value: { operations, ...(expectedRevision !== undefined ? { expectedRevision } : {}), ...(label !== undefined ? { label } : {}) } };
}

/** A remote call that passed every check, with its arguments as they will be used. */
export type LiveCall = { method: 'project.snapshot'; args: [] } | { method: 'project.apply'; args: [LiveEditBatch] };

/**
 * Check a guest's call before it runs: whether its role allows the method, then its arguments. A method takes exactly
 * the arguments named here, so nothing a guest adds (an opening, a history label key, a second options object)
 * reaches the host's API.
 */
export function checkRpcRequest(role: GuestRole, method: string, args: readonly unknown[]): CapabilityResult<LiveCall> {
  if (!canCall(role, method)) return denied(`A ${role} cannot use ${method.slice(0, 80)}.`);
  if (method === 'project.snapshot') return args.length === 0 ? { ok: true, value: { method, args: [] } } : invalid('project.snapshot takes no arguments.');
  if (args.length !== 1) return invalid('project.apply takes one batch of edits.');
  const batch = checkEditBatch(role, args[0]);
  return batch.ok ? { ok: true, value: { method: 'project.apply', args: [batch.value] } } : batch;
}
