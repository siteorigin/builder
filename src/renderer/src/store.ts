import { create } from 'zustand';
import type { AiEvent, AppSettings, ChatMessage, Conversation, LocalWorkspaceState, ProjectSnapshot, ProviderStatus, RunStatus, RuntimeState } from '@shared/api';
import type { ApplyResult, EditOperation } from '@shared/ops';
import type { ElementRef, OwnerRef, ResponsiveScope } from '@shared/types';
import { chatStatePatch, draftFor, withDraft, type ChatDrafts } from './lib/chatDrafts';
import { PANEL_DEFAULTS } from './lib/layout';
import { draftCount, HELD_DRAFT, setDraft, trackApply, type ApplyOutcome } from './lib/pending';
import { checkHeld, fieldKey, placeOf, readFields, shownField, typedText, whereOf } from './lib/held';

export const api = window.builder;

export type LeftTab = 'pages' | 'layers' | 'insert' | 'assets';
export type RightTab = 'inspect' | 'chat' | 'styles';
export type Modal = null | { kind: 'settings'; tab?: string } | { kind: 'export' } | { kind: 'source'; definitionId: string } | { kind: 'page-source'; pageId: string } | { kind: 'cmdk' } | { kind: 'create-component'; ref: ElementRef } | { kind: 'make-unique'; owner: OwnerRef; nodeId: string; definitionId: string } | { kind: 'rename-component'; definitionId: string } | { kind: 'delete-page'; pageId: string } | { kind: 'set-home'; pageId: string } | { kind: 'history'; entryId?: string } | { kind: 'new-code' } | { kind: 'edit-definition'; ref: ElementRef } | { kind: 'health' };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A typed edit made while the AI was working. It is kept until the author applies or discards it.
 * waiting: the AI is (or was) working; the author can stop it and apply the edit.
 * applying: the AI is being stopped and the edit is applied once its changes are undone.
 * changed: a field it writes holds something else now (shown in `current`); the author decides.
 * gone: what it was for no longer exists. failed: the project refused it (`note` says why).
 */
export interface HeldEdit {
  id: number;
  /** The fields it writes: a newer edit of the same fields replaces it. */
  key: string;
  /** The opening of the project it was made in (its snapshot's workspaceKey). */
  workspace: string;
  operations: EditOperation[];
  label: string;
  /** What each field held when the author made the edit. */
  base: unknown[];
  /** Where the edit is (a page title, "Header"), for the author. */
  place: string;
  /** What the author typed, when it is plain text. */
  text: string | null;
  phase: 'waiting' | 'applying' | 'changed' | 'gone' | 'failed';
  /** Commit order: a newer commit of the same fields replaces it, never an older one. */
  seq: number;
  /** While applying: the AI is being stopped first. */
  stopping?: boolean;
  /** While applying: the save is on its way and can no longer be called back. */
  writing?: boolean;
  /** For "changed": what the fields hold now; checked again before the author's edit replaces it. */
  current?: unknown[];
  currentText?: string | null;
  /** For "gone": what no longer exists. For "failed" or "waiting": why. */
  note?: string;
  /** The handoff in progress; a reply for any other is ignored. */
  attempt?: number;
}

/**
 * How the last AI request ended, for the toolbar: `run` is its final status (null when a held edit was
 * applied after the request had already ended), `edit` what happened to a held edit applied after it.
 */
export interface AiOutcome {
  run: RunStatus | null;
  /** The request `run` is the ending of. */
  runId?: string;
  edit?: 'saved' | 'held';
}

/** Counts AI activity (every status the AI reports). An edit typed while it changed knows the AI ran meanwhile. */
let aiEpoch = 0;
export const aiActivity = () => aiEpoch;

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void; undoes?: UndoTarget };
}

/** One committed change, in the opening of the project it was made in (see `undoAction`). */
export interface UndoTarget {
  entryId: string;
  workspaceKey: string;
  /** The revision the change produced: a snapshot older than this has not heard of the entry yet. */
  revision: number;
}

interface State {
  screen: 'welcome' | 'editor';
  snapshot: ProjectSnapshot | null;
  runtime: RuntimeState;
  settings: AppSettings | null;
  providers: ProviderStatus[];
  pageId: string | null;
  selection: ElementRef | null;
  hover: ElementRef | null;
  viewport: number;
  zoom: number | 'fit';
  mode: 'edit' | 'preview';
  leftTab: LeftTab | null;
  rightTab: RightTab;
  /** The preview page itself has loaded and connected (not just the website tools). */
  frameReady: boolean;
  /** Fields holding typed text that is not committed yet (the toolbar says "Editing…" rather than "Saved"). */
  drafting: number;
  /** The project is about to close (pending edits are saved): the editor takes no more input. */
  leaving: boolean;
  /** A problem the preview page itself reported (a component that failed to render), in plain words. */
  previewIssue: string | null;
  /** Whether the right dock (Inspector / AI / Site styles) is shown. */
  dockOpen: boolean;
  /** The widths the panels were given (lib/layout fits them to the window when it is too small for both). */
  leftWidth: number;
  rightWidth: number;
  styleScope: ResponsiveScope;
  rects: { selected: Rect[]; hovered: Rect[] };
  pendingSave: number;
  modal: Modal;
  toasts: Toast[];
  /** Definition editing mode: the project-owned definition being edited. */
  definitionMode: { definitionId: string; returnPageId: string } | null;
  conversation: Conversation | null;
  runStatus: RunStatus | null;
  activeRunId: string | null;
  /** Unsent messages per conversation of the open project (see lib/chatDrafts). */
  chatDrafts: ChatDrafts;
  chatContextEnabled: { page: boolean; selection: boolean };
  /** Typed edits made while the AI was working (see HeldEdit). */
  heldEdits: HeldEdit[];
  aiOutcome: AiOutcome | null;
  setState: (p: Partial<State>) => void;
}

export const useStore = create<State>((set) => ({
  screen: 'welcome',
  snapshot: null,
  runtime: { state: 'idle' },
  settings: null,
  providers: [],
  pageId: null,
  selection: null,
  hover: null,
  viewport: 1280,
  zoom: 'fit',
  mode: 'edit',
  leftTab: 'pages',
  rightTab: 'inspect',
  frameReady: false,
  drafting: 0,
  leaving: false,
  previewIssue: null,
  dockOpen: true,
  leftWidth: PANEL_DEFAULTS.left,
  rightWidth: PANEL_DEFAULTS.right,
  styleScope: 'base',
  rects: { selected: [], hovered: [] },
  pendingSave: 0,
  modal: null,
  toasts: [],
  definitionMode: null,
  conversation: null,
  runStatus: null,
  activeRunId: null,
  chatDrafts: {},
  chatContextEnabled: { page: true, selection: true },
  heldEdits: [],
  aiOutcome: null,
  setState: (p) => set(p)
}));

export const getState = () => useStore.getState();
export const setState = (p: Partial<State>) => useStore.setState(p);

/** Save workspace state (open page, viewport, tabs) to the project that is open now. */
export function saveLocal(state: LocalWorkspaceState) {
  const key = getState().snapshot?.workspaceKey;
  if (key) void api.project.saveLocalState(state, key);
}

/** The unsent message of the open conversation. */
export const selectChatDraft = (s: State) => draftFor(s.chatDrafts, s.conversation?.id);

/** Set the unsent message of one conversation (an edit while no conversation is shown has nowhere to go). */
export function setChatDraft(conversationId: string | null | undefined, text: string) {
  if (!conversationId) return;
  const drafts = getState().chatDrafts;
  const next = withDraft(drafts, conversationId, text);
  if (next !== drafts) setState({ chatDrafts: next });
}

/** Save drafts and the open conversation to the project they belong to, as they change. */
export function persistChatState(s: State, prev: State) {
  const out = chatStatePatch(
    { key: prev.snapshot?.workspaceKey ?? null, drafts: prev.chatDrafts, conversationId: prev.conversation?.id ?? null },
    { key: s.snapshot?.workspaceKey ?? null, drafts: s.chatDrafts, conversationId: s.conversation?.id ?? null }
  );
  if (out) void api.project.saveLocalState(out.patch, out.key);
}

/** The readable part of an error from the main process (Electron prefixes rejected IPC calls). */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
  const id = ++toastId;
  setState({ toasts: [...getState().toasts, { id, text, kind, action }] });
  setTimeout(() => setState({ toasts: getState().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 4000);
}

/** The typed edit being committed (see commitDraft). */
let draft: { base: ProjectSnapshot | null; text: string | null; check: boolean } | null = null;

/**
 * Commit a typed edit: `commit` calls applyOps. `base` is the project as the author saw it when editing
 * began and `text` what was typed. Only edits committed this way are held while the AI works (gestures
 * are not): one held is checked against `base` before it is applied. `check` says the AI ran while the
 * author typed: the edit is then never applied blindly, but held and checked, at once when the AI is idle.
 */
export function commitDraft<T>(base: ProjectSnapshot | null, commit: () => T, text: string | null = null, opts: { check?: boolean } = {}): T {
  const prev = draft;
  draft = { base, text, check: !!opts.check };
  try {
    return commit();
  } finally {
    draft = prev;
  }
}

/** Orders commits, so a late reply for an older one never replaces a newer edit of the same field. */
let commitSeq = 0;
/** The newest commit of each field, by opening and field key, held or not, discarded or not. */
const newestCommit = new Map<string, number>();
const fieldOf = (workspace: string | undefined, operations: EditOperation[]) => `${workspace ?? ''}\n${fieldKey(operations)}`;

/** Edits a change needs first, saved in the same batch: a section's new ID before the link that jumps to it. */
export interface PendingEdit {
  operations: EditOperation[];
  /** The project revision the edits were planned against: the batch is refused if the project has moved on. */
  expectedRevision?: number;
}

/**
 * Apply operations through the shared command service. Returns per-op results or null on failure. With
 * `expectedRevision`, the batch applies only to the project as it was at that revision.
 */
export async function applyOps(operations: EditOperation[], label: string, coalesceKey?: string, expectedRevision?: number): Promise<Array<Record<string, unknown>> | null> {
  const r = await commitOps(operations, label, coalesceKey, expectedRevision);
  return r ? (r.results ?? []) : null;
}

/** Like `applyOps`, but returns the whole result: with the history entry the change made, for an Undo beside it. */
export async function commitOps(operations: EditOperation[], label: string, coalesceKey?: string, expectedRevision?: number): Promise<(ApplyResult & { workspaceKey: string }) | null> {
  // Asked for earlier and checked before it is applied (commitIfUnchanged), whose caller follows it until it lands.
  if (checked) return applyChecked(checked, operations, label, coalesceKey, expectedRevision);
  // Followed until it lands, so saving and leaving the project wait for it and hear if it failed.
  let landed!: (o: ApplyOutcome) => void;
  trackApply(new Promise<ApplyOutcome>((r) => (landed = r)));
  const s = getState();
  const typed = draft ? { base: draft.base ?? s.snapshot, text: draft.text, seq: ++commitSeq, check: draft.check } : null;
  if (typed) newestCommit.set(fieldOf(typed.base?.workspaceKey, operations), typed.seq);
  if (s.snapshot?.aiBusy) {
    landed({ ok: false, message: refuseWhileAiBusy(typed, operations, label) });
    return null;
  }
  // Typed while the AI ran: checked against what the author saw before it is applied, never blindly.
  if (typed?.check && typed.base) {
    const held = holdEdit(typed.base, operations, label, { text: typed.text, seq: typed.seq });
    if (held) {
      const id = held.id;
      if (id === null) landed({ ok: true });
      else void applyHeld(id).then(() => landed(heldById(id) ? { ok: false, message: HELD_MESSAGE } : { ok: true }));
      return null;
    }
  }
  const workspaceKey = s.snapshot?.workspaceKey ?? '';
  setState({ pendingSave: s.pendingSave + 1 });
  try {
    // Named by the opening of its project, so a change sent just as that project closes never lands in the next.
    const r = await api.project.apply(expectedRevision === undefined ? { operations } : { operations, expectedRevision }, { label, coalesceKey, opening: s.snapshot?.workspaceKey });
    if (!r.ok) {
      // The AI started between the last snapshot and this edit.
      const message =
        r.error?.code === 'BUSY' ? refuseWhileAiBusy(typed, operations, label) : r.error?.code === 'STALE_REVISION' ? 'The project changed while you were choosing. Choose again.' : (r.error?.message ?? 'That change could not be applied.');
      if (r.error?.code !== 'BUSY') toast(message, 'error');
      landed({ ok: false, message });
      return null;
    }
    landed({ ok: true });
    return { ...r, workspaceKey };
  } catch (e) {
    const message = `That change could not be saved${e instanceof Error && e.message ? `: ${e.message}` : '.'}`;
    toast(message, 'error');
    landed({ ok: false, message });
    return null;
  } finally {
    setState({ pendingSave: Math.max(0, getState().pendingSave - 1) });
  }
}

const HELD_MESSAGE = 'An edit you made while the AI was working has not been saved yet.';

/** A typed field edit is held for the author to apply once the AI stops; anything else is refused. Returns
 *  what became of it, for a save or a leave that is waiting on it. */
function refuseWhileAiBusy(typed: { base: ProjectSnapshot | null; text: string | null; seq: number } | null, operations: EditOperation[], label: string): string {
  if (typed?.base && holdEdit(typed.base, operations, label, { text: typed.text, seq: typed.seq })) return HELD_MESSAGE;
  const message = 'The AI is making changes. Stop it to edit manually.';
  toast(message, 'error', { label: 'Stop AI', run: () => void api.ai.stop() });
  return message;
}

let heldSeq = 0;
let attemptSeq = 0;

/**
 * Hold a typed edit made against `base`. Returns null when it is not a field edit that can be checked
 * later, otherwise the held edit's ID, or null as the ID when there is nothing to hold: its project has
 * closed, or the author has committed the same fields since (`seq` orders commits), even if that newer
 * edit was saved or discarded meanwhile.
 */
export function holdEdit(base: ProjectSnapshot, operations: EditOperation[], label: string, opts: { text?: string | null; seq?: number } = {}): { id: number | null } | null {
  // A reply that arrives after its project closed has nothing to be held in.
  if (getState().snapshot?.workspaceKey !== base.workspaceKey) return { id: null };
  const reads = readFields(base.state, operations);
  if (!reads || reads.some((r) => !r.found)) return null;
  const key = fieldKey(operations);
  const seq = opts.seq ?? ++commitSeq;
  if ((newestCommit.get(fieldOf(base.workspaceKey, operations)) ?? -1) > seq) return { id: null };
  const held = getState().heldEdits;
  const edit: HeldEdit = {
    id: ++heldSeq,
    seq,
    key,
    workspace: base.workspaceKey,
    operations,
    label,
    base: reads.map((r) => (r.found ? r.value : undefined)),
    place: placeOf(base.state, operations[0]),
    text: opts.text !== undefined && opts.text !== null ? opts.text : typedText(operations[0]),
    phase: 'waiting'
  };
  // A newer edit of the same fields replaces the older one (and any handoff still running for it).
  // One already being written cannot be called back: it stays until its save answers.
  setState({ heldEdits: [...held.filter((h) => h.key !== key || h.workspace !== base.workspaceKey || h.writing), edit] });
  return { id: edit.id };
}

const heldById = (id: number) => getState().heldEdits.find((h) => h.id === id);
function patchHeld(id: number, patch: Partial<HeldEdit>, extra: Partial<State> = {}) {
  setState({ heldEdits: getState().heldEdits.map((h) => (h.id === id ? { ...h, ...patch } : h)), ...extra });
}
const removeHeld = (id: number) => getState().heldEdits.filter((h) => h.id !== id);

/** Discard a held edit. One whose save is already on its way cannot be called back. */
export function discardHeld(id: number) {
  if (heldById(id)?.writing) return;
  // Nothing was saved: the toolbar must not announce an earlier save as this one's.
  const outcome = getState().aiOutcome;
  setState({ heldEdits: removeHeld(id), aiOutcome: outcome ? { run: outcome.run, runId: outcome.runId } : null });
}

/**
 * Apply a held edit: "Stop AI and apply my edit" (`stopRunId`: the request the author chose to stop),
 * "Apply my edit" after the AI ended, or with `replace`, the author's choice to replace what a changed
 * field holds now. Only the named request is stopped, and the edit applies after its changes are rolled
 * back, and only while every field it writes still holds what the author edited (or, with `replace`,
 * what the author reviewed).
 */
export async function applyHeld(id: number, opts: { replace?: boolean; stopRunId?: string } = {}): Promise<void> {
  const held = heldById(id);
  if (!held || held.phase === 'applying' || (opts.replace && held.phase !== 'changed')) return;
  const attempt = ++attemptSeq;
  const expected = opts.replace ? held.current! : held.base;
  patchHeld(id, { phase: 'applying', attempt, stopping: !!opts.stopRunId, writing: false, note: undefined });
  const live = () => {
    const h = heldById(id);
    return h && h.attempt === attempt ? h : null;
  };
  const settle = (patch: Partial<HeldEdit>, extra: Partial<State> = {}) => patchHeld(id, { attempt: undefined, stopping: false, writing: false, ...patch }, extra);
  // How the request this stopped ended; null when it stopped none.
  let run: RunStatus | null = null;
  if (opts.stopRunId) {
    // Resolves once that request has ended and its changes are rolled back. Another request is left alone.
    let stopped: Awaited<ReturnType<typeof api.ai.stop>> | null = null;
    try {
      stopped = await api.ai.stop(opts.stopRunId);
    } catch {
      /* The snapshot below says whether it ended. */
    }
    if (stopped?.stopped) run = stopped.status ?? 'cancelled';
    else {
      // It had already ended on its own: that is how it ended, if its last status was for that request.
      const last = getState().aiOutcome;
      run = last?.runId === opts.stopRunId ? last.run : null;
    }
    if (!live()) return;
    // Only a request that ended cleanly (rolled back, or finished before the stop reached it) leaves a
    // project the edit can be checked against. One whose rollback failed or kept changes for review does not.
    if (run !== null && run !== 'cancelled' && run !== 'completed' && run !== 'no-changes')
      return settle({ phase: 'failed', note: 'The AI request did not end cleanly, so your edit was not applied. Check the page, then try again.' }, { aiOutcome: { run, edit: 'held' } });
    patchHeld(id, { stopping: false });
  }
  const outcome = (edit: AiOutcome['edit']): AiOutcome => ({ run, ...(run && opts.stopRunId ? { runId: opts.stopRunId } : {}), edit });
  for (let tries = 0; ; tries++) {
    let snap: ProjectSnapshot | null;
    try {
      snap = await api.project.snapshot();
    } catch (e) {
      if (live()) settle({ phase: 'failed', note: (e as Error).message });
      return;
    }
    const h = live();
    // Discarded, replaced by a newer edit, or the project closed meanwhile.
    if (!h) return;
    // The edit belongs to a project that is no longer open.
    if (!snap || snap.workspaceKey !== h.workspace) return setState({ heldEdits: removeHeld(id) });
    if (snap.aiBusy) return settle({ phase: 'waiting', note: 'The AI is working on another request.' });
    const check = checkHeld(snap.state, h.operations, expected);
    if (check.kind === 'gone') return settle({ phase: 'gone', note: check.what }, { aiOutcome: outcome('held') });
    if (check.kind === 'changed') return settle({ phase: 'changed', current: check.current, currentText: shownField(h.operations[0], check.current[0]) }, { aiOutcome: outcome('held') });
    patchHeld(id, { stopping: false, writing: true });
    setState({ pendingSave: getState().pendingSave + 1 });
    const writing = api.project
      .apply({ operations: h.operations, expectedRevision: snap.revision }, { label: h.label, opening: h.workspace })
      .catch((e: Error) => ({ ok: false as const, revision: 0, error: { code: 'FAILED', message: e.message } }));
    // Followed like any change on its way, so saving or leaving the project waits for it.
    trackApply(writing.then((x) => ({ ok: x.ok, message: x.error?.message })));
    const r = await writing;
    const pendingSave = Math.max(0, getState().pendingSave - 1);
    // The project closed while the save was on its way.
    if (!live()) return setState({ pendingSave });
    // In one update, so the toolbar goes straight from the AI to "your edit was saved".
    if (r.ok) return setState({ pendingSave, heldEdits: removeHeld(id), aiOutcome: outcome('saved') });
    setState({ pendingSave });
    // Something else changed the project between the check and the write: check again.
    if (r.error?.code === 'STALE_REVISION' && tries < 2) {
      patchHeld(id, { writing: false });
      continue;
    }
    if (r.error?.code === 'BUSY')
      return getState().snapshot?.aiBusy
        ? settle({ phase: 'waiting', note: 'The AI is working on another request.' })
        : settle({ phase: 'failed', note: 'The project is still locked by an AI request that did not end cleanly. Reopen the project, then try again.' }, { aiOutcome: outcome('held') });
    return settle({ phase: 'failed', note: r.error?.message ?? 'That change could not be applied.' }, { aiOutcome: outcome('held') });
  }
}

/**
 * Apply `operations` after the edits they need first, as one batch and one undo step, against the revision the
 * edit was planned on. A batch that adds edits of its own is its own undo step, never merged into the last one.
 */
export function applyWith(edit: PendingEdit | undefined, operations: EditOperation[], label: string, coalesceKey?: string) {
  if (!edit) return applyOps(operations, label, coalesceKey);
  return applyOps([...edit.operations, ...operations], label, edit.operations.length ? undefined : coalesceKey, edit.expectedRevision);
}

/**
 * The Undo for a notification about one committed change (a `commitOps` result). It undoes that history entry, in
 * the project it was made in, and never whatever happens to be newest: when later edits leave it no way to do that
 * on its own, it says why and opens History at the entry. None when the change made no history entry, or its
 * project is no longer the one open.
 */
export function undoAction(r: { entryId?: string; revision: number; workspaceKey: string }): Toast['action'] {
  const { entryId, workspaceKey } = r;
  if (!entryId || !workspaceKey || getState().snapshot?.workspaceKey !== workspaceKey) return undefined;
  // History opens at the entry only while its project is still the one open.
  const history = {
    label: 'History',
    run: () => {
      if (getState().snapshot?.workspaceKey === workspaceKey) setState({ modal: { kind: 'history', entryId } });
    }
  };
  return {
    label: 'Undo',
    undoes: { entryId, workspaceKey, revision: r.revision },
    run: () =>
      void api.project.undoEntry(entryId, workspaceKey).then(
        (res) => {
          if (!res.ok) toast(res.error?.message ?? 'That change could not be undone.', 'error', res.error?.code === 'CONFLICT' ? history : undefined);
        },
        () => toast('That change could not be undone.', 'error', history)
      )
  };
}

/** Whether a notification's Undo still has its change to undo: same project, and the entry is still applied. */
export function undoAvailable(t: UndoTarget, snap: ProjectSnapshot | null): boolean {
  if (!snap || snap.workspaceKey !== t.workspaceKey) return false;
  if (snap.revision < t.revision) return true;
  return snap.history.entries.some((e) => e.id === t.entryId && e.applied);
}

/** What became of an edit committed with commitIfUnchanged. `where` names what it writes ("Split hero on Home"). */
export type CheckedOutcome =
  | { kind: 'applied'; where: string }
  /** Checked only (`checkOnly`): every field it writes still holds what it held, and nothing was written. */
  | { kind: 'unchanged'; where: string }
  /** Something it writes was edited meanwhile: applying it would replace that newer edit. */
  | { kind: 'changed'; where: string }
  /** What it writes was removed meanwhile: `what` says what is missing ("list item", "element", "page"). */
  | { kind: 'gone'; what: string; where: string }
  /** The project is busy: the AI is working on it, or (with `message`) the project said why it is locked. */
  | { kind: 'busy'; message?: string }
  /** The project it was asked for in is no longer open. */
  | { kind: 'closed' }
  | { kind: 'failed'; message: string };

interface CheckedCommit {
  base: ProjectSnapshot;
  checkOnly: boolean;
  outcome: Promise<CheckedOutcome> | null;
}
/** The commit in progress in commitIfUnchanged: commitOps checks the edit it is handed. */
let checked: CheckedCommit | null = null;

/**
 * Commit an edit the author asked for earlier, once the work it waited on (an import) has finished, wherever the
 * author is by then. `commit` calls the change handler of the field the edit was asked for, kept from that moment,
 * so the edit goes to that field and never to whatever is selected now. `base` is the project as that field's
 * editor showed it then. The edit applies only in the same opening of the project, and only while every field it
 * writes still holds what it held in `base`: it never replaces a newer edit, and never lands on something removed
 * meanwhile. With `checkOnly`, the edit names the field and is checked the same way, but not written (the field
 * already holds what was asked for). One edit per commit. The caller follows the work as a save in flight, from
 * where it began.
 */
export function commitIfUnchanged(base: ProjectSnapshot, commit: () => unknown, opts: { checkOnly?: boolean } = {}): Promise<CheckedOutcome> {
  const prev = checked;
  const c: CheckedCommit = { base, checkOnly: !!opts.checkOnly, outcome: null };
  checked = c;
  try {
    commit();
  } catch (e) {
    c.outcome ??= Promise.resolve({ kind: 'failed', message: errorText(e) });
  } finally {
    checked = prev;
  }
  return c.outcome ?? Promise.resolve({ kind: 'failed', message: 'That change could not be made.' });
}

function applyChecked(c: CheckedCommit, operations: EditOperation[], label: string, coalesceKey?: string, expectedRevision?: number): Promise<(ApplyResult & { workspaceKey: string }) | null> {
  // One edit per commit: a second one is never applied, checked or not.
  if (c.outcome) return Promise.resolve(null);
  let result: (ApplyResult & { workspaceKey: string }) | null = null;
  c.outcome = checkAndApply(c, operations, label, coalesceKey, expectedRevision, (r) => (result = { ...r, workspaceKey: c.base.workspaceKey }));
  return c.outcome.then(() => result);
}

async function checkAndApply(c: CheckedCommit, operations: EditOperation[], label: string, coalesceKey: string | undefined, expectedRevision: number | undefined, done: (result: ApplyResult) => void): Promise<CheckedOutcome> {
  const { base } = c;
  const reads = readFields(base.state, operations);
  if (!reads || reads.some((r) => !r.found)) return { kind: 'failed', message: 'That change could not be checked.' };
  const before = reads.map((r) => (r.found ? r.value : undefined));
  // Checked first against the project as this window has it. That copy can be behind: a refusal is made only
  // after checking the project itself, and a write sent from a copy that was behind is refused and checked again.
  let snap = getState().snapshot;
  let fresh = false;
  for (let tries = 0; ; ) {
    if (!snap || snap.workspaceKey !== base.workspaceKey) return { kind: 'closed' };
    const check = checkHeld(snap.state, operations, before);
    const where = whereOf(check.kind === 'gone' ? base.state : snap.state, operations[0]);
    const refusal: CheckedOutcome | null = snap.aiBusy
      ? { kind: 'busy' }
      : check.kind === 'gone'
        ? { kind: 'gone', what: check.what, where }
        : // Edits planned against a revision (a section's new ID before the link to it) hold only for that revision.
          check.kind === 'changed' || (expectedRevision !== undefined && snap.revision !== expectedRevision)
          ? { kind: 'changed', where }
          : null;
    if (refusal && fresh) return refusal;
    // Nothing is written to refuse a check made on a copy that is behind, so it is made on the project's own.
    if (!refusal && c.checkOnly && fresh) return { kind: 'unchanged', where };
    if (!refusal && !c.checkOnly) {
      const r = await api.project
        .apply({ operations, expectedRevision: snap.revision }, { label, coalesceKey, opening: base.workspaceKey })
        .catch((e: unknown) => ({ ok: false as const, revision: 0, error: { code: 'FAILED' as const, message: errorText(e) } }));
      if (r.ok) {
        done(r);
        return { kind: 'applied', where };
      }
      if (r.error?.code === 'BUSY') return { kind: 'busy', message: r.error.message };
      if (r.error?.code !== 'STALE_REVISION' || ++tries > 2) return { kind: 'failed', message: r.error?.message ?? 'That change could not be applied.' };
    }
    try {
      snap = await api.project.snapshot();
      fresh = true;
    } catch (e) {
      return { kind: 'failed', message: errorText(e) };
    }
  }
}

export function applyAiEvent(e: AiEvent) {
  const s = getState();
  if (e.kind === 'status') {
    const terminal = ['completed', 'no-changes', 'cancelled', 'failed', 'conflicted'].includes(e.status!);
    aiEpoch++;
    setState(terminal ? { runStatus: null, activeRunId: null, aiOutcome: { run: e.status!, runId: e.runId } } : { runStatus: e.status!, activeRunId: e.runId });
    return;
  }
  const conv = s.conversation;
  if (!conv) return;
  if (e.kind === 'message' && e.message) {
    const msgs = [...conv.messages];
    const i = msgs.findIndex((m) => m.id === e.message!.id);
    if (i >= 0) msgs[i] = e.message;
    else msgs.push(e.message);
    setState({ conversation: { ...conv, messages: msgs }, activeRunId: e.runId || s.activeRunId });
  } else if (e.kind === 'text') {
    const msgs = conv.messages.map((m): ChatMessage => (m.runId === e.runId && m.role === 'assistant' ? { ...m, text: e.text ?? '' } : m));
    setState({ conversation: { ...conv, messages: msgs } });
  }
}

/** Mark or clear an uncommitted edit (a field, an inline rename, canvas text) so the toolbar says "Editing…". */
// Held edits are unsaved work: saving or leaving the project says so, as it does for any open draft.
useStore.subscribe((s, prev) => {
  if (s.heldEdits !== prev.heldEdits) markDraft(HELD_DRAFT, s.heldEdits.length > 0);
});

export function markDraft(key: string, on: boolean) {
  if (!setDraft(key, on)) return;
  useStore.setState({ drafting: draftCount() });
  // A new draft retires any "saved" notice still on screen: it no longer describes what you are typing.
  if (on) {
    const toasts = useStore.getState().toasts;
    if (toasts.some((t) => t.kind === 'success')) useStore.setState({ toasts: toasts.filter((t) => t.kind !== 'success') });
  }
}

export interface ConfirmRequest {
  /** Each question is its own dialog, so one replacing another starts with its own safe focus. */
  id: number;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** A third, safe choice ("Keep editing") that resolves like a dismissal and takes the initial focus, so
   *  a second Enter never discards anything. */
  stayLabel?: string;
  danger?: boolean;
  /** true = confirm, false = the cancel button, null = dismissed (Escape, ×, backdrop): stay where you were. */
  resolve: (ok: boolean | null) => void;
}
let confirmQueue: ConfirmRequest | null = null;
const confirmListeners = new Set<() => void>();
export function getConfirm() {
  return confirmQueue;
}
export function onConfirmChange(fn: () => void) {
  confirmListeners.add(fn);
  return () => confirmListeners.delete(fn);
}
/** Ask a yes/no question in the app's own dialog (never the system's), resolving to the answer. */
let confirmIds = 0;
export function confirmDialog(req: Omit<ConfirmRequest, 'resolve' | 'id'>): Promise<boolean | null> {
  // One question at a time: a new one dismisses an open one (as Escape would), so its caller hears an
  // answer instead of waiting forever.
  confirmQueue?.resolve(null);
  return new Promise((resolve) => {
    confirmQueue = {
      ...req,
      id: ++confirmIds,
      resolve: (ok) => {
        confirmQueue = null;
        confirmListeners.forEach((f) => f());
        resolve(ok);
      }
    };
    confirmListeners.forEach((f) => f());
  });
}
