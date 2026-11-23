import { create } from 'zustand';
import type { AiEvent, AppSettings, ChatMessage, Conversation, LocalWorkspaceState, ProjectSnapshot, ProviderStatus, RunStatus, RuntimeState } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { ElementRef, ResponsiveScope } from '@shared/types';
import { chatStatePatch, draftFor, withDraft, type ChatDrafts } from './lib/chatDrafts';

export const api = window.builder;

export type LeftTab = 'pages' | 'layers' | 'insert' | 'assets';
export type RightTab = 'inspect' | 'chat' | 'styles';
export type Modal = null | { kind: 'settings'; tab?: string } | { kind: 'export' } | { kind: 'source'; definitionId: string } | { kind: 'page-source'; pageId: string } | { kind: 'cmdk' } | { kind: 'create-component'; ref: ElementRef } | { kind: 'delete-page'; pageId: string } | { kind: 'history' } | { kind: 'new-code' } | { kind: 'edit-definition'; ref: ElementRef } | { kind: 'health' };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
  action?: { label: string; run: () => void };
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
  /** What Welcome should do when it appears after leaving a project: start a new one, or ask to trust one. */
  welcomeIntent: null | { kind: 'new' } | { kind: 'trust'; dir: string; name: string };
  /** The preview page itself has loaded and connected (not just the website tools). */
  frameReady: boolean;
  /** Fields holding typed text that is not committed yet (the toolbar says "Editing…" rather than "Saved"). */
  drafting: number;
  /** A problem the preview page itself reported (a component that failed to render), in plain words. */
  previewIssue: string | null;
  /** Whether the right dock (Inspector / AI / Site styles) is shown. */
  dockOpen: boolean;
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
  welcomeIntent: null,
  frameReady: false,
  drafting: 0,
  previewIssue: null,
  dockOpen: true,
  leftWidth: 260,
  rightWidth: 340,
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
  const s = getState();
  if (s.snapshot?.aiBusy) {
    toast('The AI is making changes. Stop it to edit manually.', 'error', { label: 'Stop AI', run: () => void api.ai.stop() });
    return null;
  }
  setState({ pendingSave: s.pendingSave + 1 });
  try {
    const r = await api.project.apply(expectedRevision === undefined ? { operations } : { operations, expectedRevision }, { label, coalesceKey });
    if (!r.ok) {
      toast(r.error?.code === 'STALE_REVISION' ? 'The project changed while you were choosing. Choose again.' : (r.error?.message ?? 'That change could not be applied.'), 'error');
      return null;
    }
    return r.results ?? [];
  } finally {
    setState({ pendingSave: Math.max(0, getState().pendingSave - 1) });
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

export function applyAiEvent(e: AiEvent) {
  const s = getState();
  if (e.kind === 'status') {
    const terminal = ['completed', 'no-changes', 'cancelled', 'failed', 'conflicted'].includes(e.status!);
    setState({ runStatus: terminal ? null : e.status!, activeRunId: terminal ? null : e.runId });
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

const drafts = new Set<string>();
/** Mark or clear an uncommitted edit (a field, an inline rename, canvas text) so the toolbar says "Editing…". */
export function markDraft(key: string, on: boolean) {
  if (on === drafts.has(key)) return;
  if (on) drafts.add(key);
  else drafts.delete(key);
  useStore.setState({ drafting: drafts.size });
  // A new draft retires any "saved" notice still on screen: it no longer describes what you are typing.
  if (on) {
    const toasts = useStore.getState().toasts;
    if (toasts.some((t) => t.kind === 'success')) useStore.setState({ toasts: toasts.filter((t) => t.kind !== 'success') });
  }
}

export interface ConfirmRequest {
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
export function confirmDialog(req: Omit<ConfirmRequest, 'resolve'>): Promise<boolean | null> {
  return new Promise((resolve) => {
    confirmQueue = {
      ...req,
      resolve: (ok) => {
        confirmQueue = null;
        confirmListeners.forEach((f) => f());
        resolve(ok);
      }
    };
    confirmListeners.forEach((f) => f());
  });
}
