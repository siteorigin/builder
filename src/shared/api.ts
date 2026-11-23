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
  | { state: 'error'; message: string; detail?: string };

export interface ProjectSnapshot {
  dir: string;
  state: ProjectState;
  revision: number;
  history: HistoryInfo;
  diagnostics: Diagnostic[];
  runtime: RuntimeState;
  recoveryNotes: string[];
  aiBusy: boolean;
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
}

export interface LocalWorkspaceState {
  pageId?: string;
  viewport?: number;
  zoom?: number | 'fit';
  leftTab?: string;
  rightTab?: string;
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
    /** The run stopped at a budget with valid work kept; the user can ask it to continue. */
    incomplete?: boolean;
  };
  question?: { text: string; choices: string[]; answered?: string };
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
    close(): Promise<void>;
    duplicate(): Promise<{ ok: boolean; message?: string; dir?: string }>;
    reveal(path?: string): Promise<void>;
  };
  project: {
    snapshot(): Promise<ProjectSnapshot | null>;
    apply(batch: EditBatch, opts?: { label?: string; coalesceKey?: string }): Promise<ApplyResult>;
    /** Copy page content as it is now, for a later `node.paste` with the returned clipboard ID. */
    copy(pageId: string, nodeId: string, expectedRevision: number): Promise<{ ok: boolean; clipboardId?: string; message?: string }>;
    undo(): Promise<ApplyResult>;
    redo(): Promise<ApplyResult>;
    importAssets(paths?: string[], only?: 'image' | 'font'): Promise<{ ok: boolean; assetIds: string[]; message?: string }>;
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
    stop(): Promise<void>;
    answer(runId: string, answer: string): Promise<void>;
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
  on(channel: 'input:key', cb: (k: { key: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }) => void): () => void;
  inspectResult(requestId: string, report: unknown): void;
  pathForFile(file: File): string;
}
