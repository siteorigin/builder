import { create } from 'zustand';
import type { AiEvent, AppSettings, ChatMessage, Conversation, ProjectSnapshot, ProviderStatus, RunStatus, RuntimeState } from '@shared/api';
import type { EditOperation } from '@shared/ops';
import type { ElementRef, ResponsiveScope } from '@shared/types';

export const api = window.builder;

export type LeftTab = 'pages' | 'layers' | 'insert' | 'assets';
export type RightTab = 'inspect' | 'chat' | 'styles';
export type Modal = null | { kind: 'settings'; tab?: string } | { kind: 'export' } | { kind: 'source'; definitionId: string } | { kind: 'page-source'; pageId: string } | { kind: 'cmdk' } | { kind: 'create-component'; ref: ElementRef } | { kind: 'delete-page'; pageId: string } | { kind: 'history' } | { kind: 'new-code' } | { kind: 'edit-definition'; ref: ElementRef };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
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
  chatDraft: string;
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
  chatDraft: '',
  chatContextEnabled: { page: true, selection: true },
  setState: (p) => set(p)
}));

export const getState = () => useStore.getState();
export const setState = (p: Partial<State>) => useStore.setState(p);

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', action?: Toast['action']) {
  const id = ++toastId;
  setState({ toasts: [...getState().toasts, { id, text, kind, action }] });
  setTimeout(() => setState({ toasts: getState().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 4000);
}

/** Apply operations through the shared command service. Returns per-op results or null on failure. */
export async function applyOps(operations: EditOperation[], label: string, coalesceKey?: string): Promise<Array<Record<string, unknown>> | null> {
  const s = getState();
  if (s.snapshot?.aiBusy) {
    toast('The AI is making changes. Stop it to edit manually.', 'error', { label: 'Stop AI', run: () => void api.ai.stop() });
    return null;
  }
  setState({ pendingSave: s.pendingSave + 1 });
  try {
    const r = await api.project.apply({ operations }, { label, coalesceKey });
    if (!r.ok) {
      toast(r.error?.message ?? 'That change could not be applied.', 'error');
      return null;
    }
    return r.results ?? [];
  } finally {
    setState({ pendingSave: Math.max(0, getState().pendingSave - 1) });
  }
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
