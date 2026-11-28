import { z } from 'zod';
import type { BuilderApi } from '../api';
import type { ElementRef } from '../types';
import { validateOperation, type EditOperation, type OperationType, type ToolErrorCode } from '../ops';
import { HOST_ONLY_PROPS, LIVE_BATCH_LABEL_MAX, MAX_ID_LENGTH, MAX_VIEWPORT_WIDTH, MIN_VIEWPORT_WIDTH, type GuestRole } from './limits';
import { canCall, LIVE_METHODS } from './roles';
import { COPY_EDITOR_OPERATIONS, copyEditorOperationProblem } from './copy-editor';
import { ELEMENT_REF, type Presence, type RpcError, type RpcErrorCode } from './messages';
import { LIVE_AI_LABEL_MAX, LIVE_AI_TEXT_MAX, type LiveAiContext } from './ai';
import { NOTE_DRAFT_SCHEMA, NOTE_ID_RE, type NoteDraft } from './notes';

/**
 * What each guest role may do, checked by the host before anything runs: deny by default. Only the methods and
 * operations listed here are ever allowed; a method or operation added to the app later stays refused for guests
 * until it is listed. Everything the host alone may do (opening, closing, exporting or revealing projects, file
 * dialogs, settings, API keys, the AI's setup and conversations, source code, versions, conflicts and history)
 * appears in no list. A collaborator's own AI requests (`ai.send`, and `ai.stop` and `ai.answer` for its own request)
 * are listed, and the host answers them only for a collaborator it has allowed AI editing (#769).
 */

export { canCall, COLLABORATOR_METHODS, COPY_EDITOR_METHODS, LIVE_METHODS, VIEWER_METHODS, type LiveMethod } from './roles';
export { HOST_ONLY_PROPS, LIVE_BATCH_LABEL_MAX };

// Every method a guest may call is one the app's API has.
type ProjectMethod = `project.${keyof BuilderApi['project'] & string}` | `ai.${keyof BuilderApi['ai'] & string}` | `notes.${keyof BuilderApi['notes'] & string}`;
const _methodsExist: readonly ProjectMethod[] = LIVE_METHODS;
void _methodsExist;

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
  'instance.setListSource',
  'node.setRepeatSource',
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

// A copy editor makes only edits a collaborator may make too (and fewer of them: engine/copy-editor.ts).
const _copyEditsCollaborate: readonly (typeof COLLABORATOR_OPERATIONS)[number][] = COPY_EDITOR_OPERATIONS;
void _copyEditsCollaborate;

const OPERATIONS: Record<GuestRole, readonly string[]> = { viewer: [], 'copy-editor': COPY_EDITOR_OPERATIONS, collaborator: COLLABORATOR_OPERATIONS };

/**
 * Where a guest's edits may land: pages, and the shared header and footer. Component definitions and collection
 * layout templates are shared designs every placement or entry shows, outside a collaborator's grant, whichever
 * operation would reach them.
 */
export const GUEST_OWNER_KINDS = ['page', 'shell'] as const;

/**
 * The page settings a collaborator may change: its name, address, search text and image, its shared parts, and an
 * article's byline and excerpt (copy the page shows). Whether and when a page is published, indexed, listed in News
 * or dated stays with the host.
 */
export const COLLABORATOR_PAGE_FIELDS = ['title', 'navLabel', 'route', 'seoTitle', 'description', 'socialImage', 'showHeader', 'showFooter', 'byline', 'excerpt'] as const;

const isHostOnlyProp = (prop: string) => (HOST_ONLY_PROPS as readonly string[]).includes(prop);

/** Why an allowed operation type still reaches past a guest's grant, or null when it does not. */
function beyondGuestGrant(op: EditOperation): string | null {
  for (const key of ['owner', 'toOwner'] as const) {
    const owner = (op as Partial<Record<typeof key, { kind: string }>>)[key];
    if (owner && !(GUEST_OWNER_KINDS as readonly string[]).includes(owner.kind)) return `Guests edit pages and the shared header and footer, not a ${owner.kind}.`;
  }
  if (op.type === 'instance.setProp' && isHostOnlyProp(op.prop)) return `Only the host can change "${op.prop}".`;
  // Nor bind one to each entry of a collection loop it is repeated in, which sets it as surely.
  if (op.type === 'node.setBinding' && op.field === 'prop' && op.prop !== undefined && isHostOnlyProp(op.prop)) return `Only the host can change "${op.prop}".`;
  if (op.type === 'node.insert' && op.props) {
    const prop = Object.keys(op.props).find(isHostOnlyProp);
    if (prop) return `Only the host can set "${prop}".`;
  }
  if (op.type === 'page.update') {
    const fields = Object.keys(op).filter((k) => k !== 'type' && k !== 'pageId' && !(COLLABORATOR_PAGE_FIELDS as readonly string[]).includes(k));
    if (fields.length) return `Only the host can change a page’s ${fields.join(', ')}.`;
  }
  // A new page is held to the same: dating it (an article starter is dated today) or keeping it out of News is the host's.
  if (op.type === 'page.create') {
    if (op.starter === 'article') return 'Only the host can start an article.';
    const fields = (['articleDate', 'newsHidden', 'draft'] as const).filter((k) => op[k] !== undefined);
    if (fields.length) return `Only the host can set a new page’s ${fields.join(', ')}.`;
  }
  return null;
}

/** Whether a guest holding `role` may make an edit of this operation type. Viewers make none. */
export function canEditOperation(role: GuestRole, type: string): boolean {
  return Object.hasOwn(OPERATIONS, role) && OPERATIONS[role].includes(type);
}

export const LIVE_BATCH_MAX_OPERATIONS = 256;
/**
 * Copies a guest's batch may make. Each copy can double what the next one copies (a section copied into itself), so
 * a batch of them could make more than the host's memory holds before anything checks the result.
 */
export const LIVE_BATCH_MAX_COPIES = 4;
const COPYING: readonly string[] = ['node.copy', 'node.duplicate', 'page.duplicate'];

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
// Every refusal the engine gives can be passed on to a guest as it is. ONE_CHANGE_PER_TURN and UPDATE_HELD are an AI
// run's own refusals of a tool call, never a change's, so no guest edit is refused with them. SAVE_FAILED is the
// editor's own account of its change that could not be written (Controller.apply), never a guest's.
const _everyEngineCode: Exclude<ToolErrorCode, RpcErrorCode | 'ONE_CHANGE_PER_TURN' | 'UPDATE_HELD' | 'SAVE_FAILED'> extends never ? true : never = true;
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
 * operation itself, as the local pipeline validates it, then where it lands and what it sets (beyondGuestGrant), and
 * for a copy editor, what the operation alone says of it (copyEditorOperationProblem). One refused operation refuses
 * the whole batch, naming it. Only the parsed operations come back, so what runs is exactly what was checked. A copy
 * editor's batch is held to the project as well, as it is saved (engine/copy-editor.ts).
 */
export function checkEditBatch(role: GuestRole, input: unknown): CapabilityResult<LiveEditBatch> {
  if (!canCall(role, 'project.apply')) return denied('Only collaborators and copy editors can edit this project.');
  const batch = BATCH.safeParse(input);
  if (!batch.success) {
    const issue = batch.error.issues[0];
    return invalid(`${issue.path.map(String).join('.') || 'batch'}: ${issue.message}`);
  }
  const operations: EditOperation[] = [];
  for (const [index, raw] of batch.data.operations.entries()) {
    const type = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { type?: unknown }).type : undefined;
    if (typeof type !== 'string') return invalid('Each operation needs a type.', index);
    if (!canEditOperation(role, type)) return denied(`A ${role.replace('-', ' ')} cannot make "${type.slice(0, 60)}" edits.`, index);
    const checked = validateOperation(raw);
    if (!checked.ok) return invalid(checked.message, index);
    const beyond = beyondGuestGrant(checked.op) ?? (role === 'copy-editor' ? copyEditorOperationProblem(checked.op) : null);
    if (beyond) return denied(beyond, index);
    if (COPYING.includes(checked.op.type) && operations.filter((o) => COPYING.includes(o.type)).length >= LIVE_BATCH_MAX_COPIES) return invalid(`A batch may copy at most ${LIVE_BATCH_MAX_COPIES} things.`, index);
    operations.push(checked.op);
  }
  const { expectedRevision, label } = batch.data;
  return { ok: true, value: { operations, ...(expectedRevision !== undefined ? { expectedRevision } : {}), ...(label !== undefined ? { label } : {}) } };
}

/** A remote call that passed every check, with its arguments as they will be used. */
export type LiveCall =
  | { method: 'project.snapshot'; args: [] }
  | { method: 'project.apply'; args: [LiveEditBatch] }
  | { method: 'ai.send'; args: [string, LiveAiContext] }
  | { method: 'ai.stop'; args: [string] }
  | { method: 'ai.answer'; args: [string, string, string] }
  | { method: 'notes.list'; args: [] }
  | { method: 'notes.add'; args: [NoteDraft] }
  | { method: 'notes.resolve'; args: [string, boolean] }
  | { method: 'notes.delete'; args: [string] };

/** Text a person wrote, with something in it. */
const words = (max: number) => z.string().max(max).refine((t) => t.trim().length > 0, { message: 'Must not be blank.' });
const runRef = z.string().min(1).max(128);

/**
 * What a collaborator's AI request may be about: the page it shows, or one element selected there or in the shared
 * header or footer. Nothing else a request can carry on the host (a component edited everywhere, a post, a layout, a
 * model, a conversation, attached images) is accepted, so the host's AI is never pointed past what the guest edits.
 */
const AI_CONTEXT = z
  .object({
    scope: z.enum(['page', 'selection']),
    pageId: z.string().min(1).max(MAX_ID_LENGTH),
    selection: ELEMENT_REF.nullable(),
    selectionLabel: z.string().max(LIVE_AI_LABEL_MAX).nullable().optional(),
    viewport: z.number().int().min(MIN_VIEWPORT_WIDTH).max(MAX_VIEWPORT_WIDTH)
  })
  .strict()
  .refine((c) => (c.scope === 'selection') === (c.selection !== null), { message: 'A selection request names its selection, and a page request none.', path: ['selection'] })
  .refine((c) => !c.selection || c.selection.owner.kind === 'shell' || (c.selection.owner.kind === 'page' && c.selection.owner.id === c.pageId), {
    message: 'The selection is on the page the request is about, or in the shared header or footer.',
    path: ['selection']
  });

const AI_SEND = z.tuple([words(LIVE_AI_TEXT_MAX), AI_CONTEXT]);
const AI_STOP = z.tuple([runRef]);
const AI_ANSWER = z.tuple([runRef, runRef, words(LIVE_AI_TEXT_MAX)]);

/** The first problem a parse found, as a guest is told it. */
const issueOf = (method: string, error: z.ZodError) => {
  const issue = error.issues[0];
  return invalid(`${method}: ${issue.path.map(String).join('.') || 'arguments'}: ${issue.message}`);
};

const isNoteId = (id: unknown): id is string => typeof id === 'string' && NOTE_ID_RE.test(id);

/** A note call's arguments, checked: a draft, or the note named (and, to resolve it, whether it is done). */
function checkNoteCall(method: string, args: readonly unknown[]): CapabilityResult<LiveCall> {
  if (method === 'notes.list') return args.length === 0 ? { ok: true, value: { method, args: [] } } : invalid('notes.list takes no arguments.');
  if (method === 'notes.add') {
    if (args.length !== 1) return invalid('notes.add takes one note.');
    const draft = NOTE_DRAFT_SCHEMA.safeParse(args[0]);
    if (!draft.success) {
      const issue = draft.error.issues[0];
      return invalid(`${issue.path.map(String).join('.') || 'note'}: ${issue.message}`);
    }
    return { ok: true, value: { method, args: [draft.data] } };
  }
  if (method === 'notes.resolve') return args.length === 2 && isNoteId(args[0]) && typeof args[1] === 'boolean' ? { ok: true, value: { method, args: [args[0], args[1]] } } : invalid('notes.resolve takes a note’s ID and whether it is resolved.');
  if (method === 'notes.delete') return args.length === 1 && isNoteId(args[0]) ? { ok: true, value: { method, args: [args[0]] } } : invalid('notes.delete takes a note’s ID.');
  return denied(`${method.slice(0, 80)} is not a note call.`);
}

/**
 * Check a guest's call before it runs: whether its role allows the method, then its arguments. A method takes exactly
 * the arguments named here, so nothing a guest adds (an opening, a history label key, a second options object, a
 * model to send to) reaches the host's API. Whether the host lets this collaborator use its AI is the host's to check.
 */
export function checkRpcRequest(role: GuestRole, method: string, args: readonly unknown[]): CapabilityResult<LiveCall> {
  if (!canCall(role, method)) return denied(`A ${role.replace('-', ' ')} cannot use ${method.slice(0, 80)}.`);
  if (method.startsWith('notes.')) return checkNoteCall(method, args);
  switch (method) {
    case 'project.snapshot':
      return args.length === 0 ? { ok: true, value: { method, args: [] } } : invalid('project.snapshot takes no arguments.');
    case 'project.apply': {
      if (args.length !== 1) return invalid('project.apply takes one batch of edits.');
      const batch = checkEditBatch(role, args[0]);
      return batch.ok ? { ok: true, value: { method: 'project.apply', args: [batch.value] } } : batch;
    }
    case 'ai.send': {
      const parsed = AI_SEND.safeParse(args);
      if (!parsed.success) return issueOf(method, parsed.error);
      const [text, ctx] = parsed.data;
      const context: LiveAiContext = { scope: ctx.scope, pageId: ctx.pageId, selection: ctx.selection, viewport: ctx.viewport, ...(ctx.selectionLabel ? { selectionLabel: ctx.selectionLabel } : {}) };
      return { ok: true, value: { method, args: [text.trim(), context] } };
    }
    case 'ai.stop': {
      const parsed = AI_STOP.safeParse(args);
      return parsed.success ? { ok: true, value: { method, args: parsed.data } } : issueOf(method, parsed.error);
    }
    case 'ai.answer': {
      const parsed = AI_ANSWER.safeParse(args);
      return parsed.success ? { ok: true, value: { method, args: [parsed.data[0], parsed.data[1], parsed.data[2].trim()] } } : issueOf(method, parsed.error);
    }
    default:
      return denied('That is not something a guest can do.');
  }
}
