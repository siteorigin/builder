import type { ApplyResult, EditBatch } from './ops';
import type { ElementRef, OwnerRef, ProjectState } from './types';
import type { ThemeUpdates } from '@engine/theme-updates';
import type { LocalProviderSettings } from './local';

export type Appearance = 'system' | 'light' | 'dark';
export type ProviderId = 'openai' | 'anthropic' | 'local';

export interface RecentProject {
  dir: string;
  name: string;
  openedAt: string;
  missing?: boolean;
}

export interface AppSettings {
  appearance: Appearance;
  /** Shows code components and source editing. Off by default: most users never need code. */
  developerMode: boolean;
  ai: {
    provider: ProviderId | null;
    models: Record<ProviderId, string>;
    local: LocalProviderSettings;
    sendOnEnter: boolean;
    setupAcknowledged: boolean;
  };
}

export type SettingsPatch = Omit<Partial<AppSettings>, 'ai'> & { ai?: Partial<Omit<AppSettings['ai'], 'local'>> & { local?: Partial<LocalProviderSettings> } };

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  configured: boolean;
  source: 'stored' | 'session' | 'environment' | null;
  /** Keys live in a local file for this user account; the OS keychain is never used. */
  storage: 'local-file';
  models: Array<{ id: string; label: string; note?: string }>;
  /** Shown wherever the user decides what to send: project content would leave this computer. */
  warning?: string;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  owner?: { kind: string; id: string };
  nodeId?: string;
}

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  entries: Array<{ id: string; label: string; source: string; time: string; applied: boolean; runId?: string }>;
}

export type RuntimeState =
  | { state: 'idle' }
  | { state: 'preparing'; message: string }
  | { state: 'starting' }
  | { state: 'ready'; url: string }
  | { state: 'error'; message: string; detail?: string }
  /** No preview can run for this project here (a newer format); nothing to retry. */
  | { state: 'unavailable'; message: string };

export interface ProjectSnapshot {
  dir: string;
  state: ProjectState;
  revision: number;
  history: HistoryInfo;
  diagnostics: Diagnostic[];
  runtime: RuntimeState;
  recoveryNotes: string[];
  aiBusy: boolean;
  /** The AI request being worked on, while `aiBusy`. */
  aiRunId?: string | null;
  assetUsage: Record<string, number>;
  /** Files changed outside the app. canonical: a project document (keep or restore); generated: a derived file (restore). */
  conflicts: Array<{ path: string; reason: string; kind: 'canonical' | 'generated' }>;
  /** Set when the project is open for inspection only (a newer format, or another app is editing it). */
  readOnly?: { reason: string; canUnlock: boolean } | null;
  /** Installed theme components with a newer version in the theme. */
  themeUpdates?: ThemeUpdates;
  localState: LocalWorkspaceState;
  /** Names this opening of the project; workspace saves carry it, so one meant for another opening is dropped. */
  workspaceKey: string;
  /** What this opening of the project exported, newest first. */
  recentExports: RecentExport[];
}

export interface LocalWorkspaceState {
  pageId?: string;
  viewport?: number;
  zoom?: number | 'fit';
  leftTab?: string;
  rightTab?: string;
  /** The widths the sidebar and right panel were last given; a small window draws them narrower. */
  leftWidth?: number;
  rightWidth?: number;
  /** Unsent AI messages, keyed by the conversation they were written in. */
  chatDrafts?: Record<string, string>;
  /** The AI conversation that was open, shown again (with its draft) when the project reopens. */
  chatConversation?: string;
}

export interface CreateProjectOptions {
  name: string;
  parentDir: string;
  starter: 'business' | 'blank';
  sampleImages: boolean;
}

export interface ProgressEvent {
  step: 'files' | 'dependencies' | 'preview' | 'done' | 'error';
  message: string;
  detail?: string;
}

/** Exports are written as a new folder or a single ZIP file. */
export type ExportFormat = 'folder' | 'zip';

export interface ExportResult {
  ok: boolean;
  path?: string;
  message: string;
  warnings: string[];
  revision?: number;
  previewUrl?: string;
}

/** An export the open project made since it was opened, so the author can find and compare what they handed off. */
export interface RecentExport {
  /** The finished website, or the editable project. */
  kind: 'site' | 'source';
  format: ExportFormat;
  /** The folder or ZIP file that was written. */
  path: string;
  /** The project revision the export was made from. */
  revision: number;
  /** When the export finished (ISO 8601). */
  exportedAt: string;
  /** A website folder's loopback preview, while it runs; it stops when the project closes. */
  previewUrl?: string;
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export type RunStatus = 'preparing' | 'running' | 'awaiting-input' | 'validating' | 'repairing' | 'stopping' | 'completed' | 'no-changes' | 'cancelled' | 'failed' | 'conflicted';

export interface ChatContext {
  pageId: string;
  pageTitle: string;
  selection: ElementRef | null;
  selectionLabel: string | null;
  viewport: number;
}

export interface ChatActivity {
  id: string;
  label: string;
  status: 'running' | 'done' | 'error';
  detail?: string;
  tool?: string;
}

export interface ChatChange {
  /** What changed and where, in plain words. */
  label: string;
  pageId?: string;
  nodeId?: string;
  definitionId?: string;
  /** The document the element is in, so header, footer and component elements can be shown too. */
  owner?: OwnerRef;
  /** The raw operation types behind this change: technical detail, shown only in Developer mode. */
  operations?: string[];
}

/** pass: the check ran and found nothing; issue: the site has a problem; unverified: the check itself could not tell. */
export type CheckStatus = 'pass' | 'issue' | 'unverified';
export interface ChatCheck {
  status: CheckStatus;
  text: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  time: string;
  context?: ChatContext;
  runId?: string;
  activities?: ChatActivity[];
  result?: {
    status: RunStatus;
    summary: string;
    changes: ChatChange[];
    /** The check lines in plain words. Results stored before `checks` existed have only these. */
    validation: string[];
    /** The same checks with their status; `validation` is their text. */
    checks?: ChatCheck[];
    canUndo: boolean;
    error?: string;
    usage?: { inputTokens: number; outputTokens: number };
    /**
     * The request is not finished: the run stopped at a budget, or ended with requested work still missing. Any
     * valid work is kept, and the user can ask it to continue.
     */
    incomplete?: boolean;
    /**
     * Pages the request tried to create that still do not exist; a "continue" request checks for them again.
     * `existing` lists pages that already had the title, which do not count as the one that was wanted.
     */
    unfinished?: Array<{ title: string; route?: string; existing?: string[] }>;
    /** Links still waiting for a page to take their route; a "continue" request connects them when it does. */
    pendingLinks?: Array<{ route: string; pageId: string; nodeId: string; prop: string; itemId?: string; field?: string }>;
  };
  /** Every question the assistant asked during this turn, in the order asked. */
  questions?: ChatQuestion[];
  /** The only question of a turn stored before `questions` existed; read through `turnQuestions`. */
  question?: ChatQuestion;
}

/** One question the assistant asked, and the user's answer once given. */
export interface ChatQuestion {
  /** Names the question an answer is for. Questions stored before it existed have none. */
  id?: string;
  text: string;
  choices: string[];
  answered?: string;
  /** Only its choices grant it: a scope-widening question. */
  widen?: boolean;
}

/** A turn's questions in order, including one stored by an earlier version as `question`. */
export function turnQuestions(m: Pick<ChatMessage, 'questions' | 'question'>): ChatQuestion[] {
  if (Array.isArray(m.questions)) return m.questions;
  return m.question ? [m.question] : [];
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  messages: ChatMessage[];
}

export interface AiEvent {
  runId: string;
  conversationId: string;
  kind: 'status' | 'text' | 'activity' | 'result' | 'question' | 'message';
  status?: RunStatus;
  text?: string;
  activity?: ChatActivity;
  message?: ChatMessage;
}

export interface BuilderApi {
  platform: string;
  app: {
    info(): Promise<{ version: string; platform: string; dev: boolean }>;
    getSettings(): Promise<AppSettings>;
    setSettings(patch: SettingsPatch): Promise<AppSettings>;
    openExternal(url: string): Promise<void>;
  };
  /** The focused text field's own history (the browser's Undo and Redo), never the project's. */
  edit: {
    undo(): Promise<void>;
    redo(): Promise<void>;
  };
  dialogs: {
    chooseFolder(title: string, defaultPath?: string): Promise<string | null>;
    chooseImages(): Promise<string[]>;
    defaultProjectsFolder(): Promise<string>;
  };
  projects: {
    recents(): Promise<RecentProject[]>;
    removeRecent(dir: string): Promise<void>;
    create(opts: CreateProjectOptions): Promise<{ ok: boolean; message?: string }>;
    cancelCreate(): Promise<void>;
    open(dir?: string): Promise<{ ok: boolean; message?: string; needsTrust?: { dir: string; name: string } }>;
    trustAndOpen(dir: string): Promise<{ ok: boolean; message?: string }>;
    /** ok is false when the author chose to keep editing a change that could not be saved. */
    close(): Promise<{ ok: boolean }>;
    duplicate(): Promise<{ ok: boolean; message?: string; dir?: string }>;
    reveal(path?: string): Promise<void>;
  };
  project: {
    snapshot(): Promise<ProjectSnapshot | null>;
    /** `opening` is the snapshot's workspaceKey of the project the change was made in: any other refuses it. */
    apply(batch: EditBatch, opts?: { label?: string; coalesceKey?: string; opening?: string }): Promise<ApplyResult>;
    /** Copy page content as it is now, for a later `node.paste` with the returned clipboard ID. */
    copy(pageId: string, nodeId: string, expectedRevision: number): Promise<{ ok: boolean; clipboardId?: string; message?: string }>;
    undo(): Promise<ApplyResult>;
    /**
     * Undo one history entry (`ApplyResult.entryId`) of the opening `workspaceKey`, for an Undo offered beside that
     * change. The newest entry is undone like Undo; an older one is reversed on its own as a new change when later
     * edits allow it, and refused with CONFLICT otherwise.
     */
    undoEntry(entryId: string, workspaceKey: string): Promise<ApplyResult>;
    redo(): Promise<ApplyResult>;
    importAssets(paths?: string[], only?: 'image' | 'font'): Promise<{ ok: boolean; assetIds: string[]; message?: string }>;
    /** What private metadata an image asset's original carries, which website exports leave out. Null when it cannot be read. */
    photoMetadata(assetId: string): Promise<{ location: boolean; device: boolean } | null>;
    exportSource(format?: ExportFormat): Promise<ExportResult>;
    exportStatic(format?: ExportFormat): Promise<ExportResult>;
    retryPreview(): Promise<void>;
    repairDependencies(): Promise<void>;
    readSource(definitionId: string): Promise<{ source: string; hash: string; path: string; editable: boolean }>;
    generatedSource(kind: 'component' | 'page', id: string): Promise<string>;
    restoreGenerated(path: string): Promise<void>;
    resolveConflict(path: string, choice: 'keep' | 'restore'): Promise<{ ok: boolean; message?: string }>;
    unlock(): Promise<{ ok: boolean; message?: string }>;
    /** `workspaceKey` is the opening of the project the state belongs to (from its snapshot); any other is dropped. */
    saveLocalState(state: LocalWorkspaceState, workspaceKey: string): Promise<void>;
    validateSource(source: string): Promise<{ ok: boolean; errors: string[]; diagnostics: Array<{ message: string; line?: number; column?: number; severity: 'error' | 'warning' }> }>;
    flush(): Promise<void>;
  };
  ai: {
    providers(): Promise<ProviderStatus[]>;
    setKey(provider: ProviderId, key: string | null): Promise<ProviderStatus[]>;
    /** Test a key and model; the typed (unsaved) key and model are used when given. */
    testProvider(provider: ProviderId, key?: string, model?: string): Promise<{ ok: boolean; message: string }>;
    /** Models the saved local server reports. */
    localModels(): Promise<{ ok: boolean; models: string[]; message?: string }>;
    conversations(): Promise<{ active: Conversation; list: Array<{ id: string; title: string; createdAt: string }> }>;
    newConversation(): Promise<Conversation>;
    openConversation(id: string): Promise<Conversation>;
    /** `workspaceKey` is the opening of the project the user confirmed this in; main refuses any other. */
    clearHistory(workspaceKey?: string): Promise<Conversation>;
    /** `conversationId` is the conversation the message was written in; main refuses it if another one is open. */
    send(text: string, context: ChatContext, conversationId?: string): Promise<{ ok: boolean; runId?: string; message?: string }>;
    /** Stop the AI. Given the request's ID, resolves once that request has ended and its changes are
     *  rolled back; `stopped` is false when it had already ended (or another request is running). */
    stop(): Promise<void>;
    stop(runId: string): Promise<{ stopped: boolean; status?: RunStatus }>;
    /** Answer the run's waiting question; false when that question is no longer waiting or the answer is blank. */
    answer(runId: string, questionId: string, answer: string): Promise<boolean>;
    undoTurn(runId: string): Promise<{ ok: boolean; message?: string }>;
    fixCode(source: string): Promise<{ ok: boolean; source?: string; explanation?: string; message?: string; cancelled?: boolean }>;
    /** Cancel an in-flight fixCode request. */
    cancelFix(): Promise<void>;
  };
  on(channel: 'project:changed', cb: (snap: ProjectSnapshot) => void): () => void;
  on(channel: 'project:closed', cb: () => void): () => void;
  on(channel: 'create:progress', cb: (p: ProgressEvent) => void): () => void;
  on(channel: 'runtime:status', cb: (s: RuntimeState) => void): () => void;
  on(channel: 'ai:event', cb: (e: AiEvent) => void): () => void;
  on(channel: 'appearance', cb: (dark: boolean) => void): () => void;
  on(channel: 'inspect:request', cb: (req: { requestId: string; pageId: string; width: number }) => void): () => void;
  on(channel: 'menu:command', cb: (cmd: string) => void): () => void;
  /** The app is about to leave the project (close, switch, close the window, quit): settle edits, then answer with leaveResult. */
  on(channel: 'lifecycle:request', cb: (req: { requestId: string }) => void): () => void;
  /** Edit → Undo or Redo, chosen from the menu or reached by its key (`fromKey`) when nothing on the page took the key. */
  on(channel: 'menu:history', cb: (e: { action: 'undo' | 'redo'; fromKey: boolean }) => void): () => void;
  on(channel: 'input:key', cb: (k: { key: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }) => void): () => void;
  inspectResult(requestId: string, report: unknown): void;
  /** 'asking' while the author decides about a change that cannot be saved; then 'leave' or 'stay'. */
  leaveResult(requestId: string, answer: 'leave' | 'stay' | 'asking'): void;
  pathForFile(file: File): string;
}
