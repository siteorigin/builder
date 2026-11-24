import type { ApplyResult, EditBatch } from './ops';
import type { ElementRef, OwnerRef, ProjectState } from './types';
import type { ThemeUpdates } from '@engine/theme-updates';
import type { LocalProviderSettings } from './local';
import type { ComponentPreviewResult, ComponentPreviewStep, PreparedComponentPreview } from './component-preview';
import type { ComponentThumb } from './component-thumbs';
import type { ThemePack } from '@catalogue/pack';

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

/** A library image whose files are not in the project folder: its original, and which listed copies. */
export interface MissingAssetFiles {
  assetId: string;
  original: boolean;
  variants: string[];
}

export interface HistoryInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  entries: Array<{ id: string; label: string; source: string; time: string; applied: boolean; runId?: string }>;
}

/** One saved version of the site, as History lists it (issue 260). */
export interface SavedVersionInfo {
  id: string;
  name: string;
  /** When it was saved (ISO time). */
  time: string;
  /** Saved by the app before a restore, as the way back to the work that restore replaced. */
  auto: boolean;
  /** How many pages it holds. */
  pages: number;
  /** What deleting it frees: what no other saved version also holds. */
  bytes: number;
  /** Files its documents name that were missing from the project folder when it was saved. */
  missing: string[];
}

/** The saved versions of the open project. */
export interface VersionsInfo {
  /** Newest first. */
  list: SavedVersionInfo[];
  /** What all saved versions take together, each file counted once. */
  bytes: number;
  /** Why versions can't be saved or deleted (their list could not be read), if so. */
  problem?: string;
}

/** What restoring a saved version would change in the project as it is now. */
export interface VersionReview {
  /** The revision this was worked out at: a restore passes it back, and a project changed since is refused. */
  revision: number;
  /** Why the version can't be restored, if so. */
  problem?: string;
  /** Page titles: pages that come back, pages that go, and pages that change. */
  pages: { back: string[]; gone: string[]; changed: string[] };
  /** Site settings (name, header, footer, addresses) change. */
  site: boolean;
  /** Site styles (colors, fonts, spacing) change. */
  styles: boolean;
  /** How many components change, come back or go. */
  components: number;
  /** The image and font library changes. */
  library: boolean;
  /** Files put back in the project folder: missing now, or holding something else. */
  files: string[];
  /** Of those, the files there now holding something else: Undo leaves them as the version has them. */
  replaced: string[];
  /** Files the restore that saved this version put where none were, which restoring it leaves (Undo of that needs them). */
  left: string[];
  /** Files its documents name that were missing when it was saved: restoring can't bring them back. */
  missing: string[];
  /** The project already matches it. */
  unchanged: boolean;
}

export interface RestoreVersionResult {
  ok: boolean;
  message?: string;
  revision?: number;
  /** The history entry the restore made, for its Undo. Absent when only files changed. */
  entryId?: string;
  /** The saved version that holds the work the restore replaced. */
  backup?: { id: string; name: string };
  /** The project changed since the version was reviewed: review it again. */
  stale?: boolean;
  /** The project already matched the version, so nothing changed. */
  unchanged?: boolean;
  /** How many files that held something else it put back: Undo leaves them, the saved work from before has them. */
  replaced?: number;
  /** Files an earlier restore put back that this one leaves in the project folder. */
  left?: string[];
}

export type RuntimeState =
  | { state: 'idle' }
  | { state: 'preparing'; message: string }
  | { state: 'starting' }
  | { state: 'ready'; url: string }
  | { state: 'error'; message: string; detail?: string }
  /** No preview can run for this project here (a newer format); nothing to retry. */
  | { state: 'unavailable'; message: string };

/**
 * A copy of one version of a file in conflict, saved when the author chose the other version in Project health, so
 * the version that was not used can still be found, read and taken back.
 */
export interface SavedCopy {
  id: string;
  /** The project file it is a copy of. */
  path: string;
  /** canonical: a project document; generated: a file SiteOrigin Builder makes from the pages. */
  kind: 'canonical' | 'generated';
  /** external: the file as it was edited outside the app; builder: SiteOrigin Builder's version. */
  side: 'external' | 'builder';
  /** When it was saved, in milliseconds since 1970. */
  savedAt: number;
  /** Where the copy is, relative to the project folder. */
  file: string;
}

/** A version of a file as text to show, or why it is not shown as text. */
export type FileText = { state: 'text'; text: string } | { state: 'missing' } | { state: 'binary' } | { state: 'too-large' } | { state: 'unreadable' };

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
  /** Library images whose files are missing from the project folder, as last checked. */
  missingAssets: MissingAssetFiles[];
  /** Files changed outside the app. canonical: a project document (keep or restore); generated: a derived file (restore). */
  conflicts: Array<{ path: string; reason: string; kind: 'canonical' | 'generated'; builderMissing?: boolean }>;
  /** Copies of the versions the author chose against when settling conflicts, newest first. */
  savedCopies?: SavedCopy[];
  /** Set when the project is open for inspection only (a newer format, or another app is editing it). */
  readOnly?: { reason: string; canUnlock: boolean } | null;
  /** Installed theme components with a newer version in the theme. */
  themeUpdates?: ThemeUpdates;
  localState: LocalWorkspaceState;
  /** Names this opening of the project; workspace saves carry it, so one meant for another opening is dropped. */
  workspaceKey: string;
  /** What this opening of the project exported, newest first. */
  recentExports: RecentExport[];
  /** Named versions of the site saved in this project. */
  versions?: VersionsInfo;
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
  /** Library images attached to those unsent messages, by asset ID, keyed the same way. */
  chatImages?: Record<string, string[]>;
  /** The AI conversation that was open, shown again (with its draft) when the project reopens. */
  chatConversation?: string;
  /** Whether the next AI message was set to be a read-only question, so an unsent question stays one. */
  chatMode?: 'edit' | 'ask';
  /** The starter's sample contact details the author chose to keep, which the export no longer reviews. */
  keptSamples?: string[];
}

export interface CreateProjectOptions {
  name: string;
  parentDir: string;
  starter: 'business' | 'blank';
  sampleImages: boolean;
  /** Names this attempt in its progress events, so a dialog follows only its own (another may still be running). */
  attempt?: string;
}

/**
 * What creating a project does about its website tools: install them from copies already on this computer, download
 * some of them, or (without a lock to check) possibly download some.
 */
export type WebsiteTools = 'local' | 'download' | 'unknown';

export interface ProgressEvent {
  step: 'files' | 'dependencies' | 'preview' | 'done' | 'error';
  message: string;
  detail?: string;
  /** The attempt this is about, as its create call named it. */
  attempt?: string;
}

/** Files and bytes on disk. */
export interface StorageSize {
  files: number;
  bytes: number;
}

/**
 * Freeing the space that removed images and fonts take. History is trimmed from its ends only, so every step
 * that stays still undoes and redoes; the files only the dropped steps could bring back are then deleted.
 */
export interface ReclaimPlan {
  /** Names exactly this plan: a reclaim with another key (the project changed since) is refused. */
  key: string;
  /** The removed files deleted, and the history versions only the dropped steps used. */
  files: StorageSize;
  historyBytes: number;
  /** Undo steps that go, oldest first. They are the oldest steps: everything after them stays undoable. */
  undo: string[];
  /** Redo steps that go, nearest first. They are the furthest ones: those before them can still be redone. */
  redo: string[];
  /** Undo and redo steps that stay. */
  keptUndo: number;
  keptRedo: number;
}

/** What the open project's media and undo history take on disk. */
export interface StorageInfo {
  /** Files the project uses now: library images and fonts with their responsive copies, and files code names. */
  media: StorageSize;
  /** Imported files nothing uses now, kept so that Undo, Redo or recovery can still bring them back. */
  kept: StorageSize;
  /** The saved document versions Undo and Redo restore. */
  history: { steps: number; bytes: number };
  /** Named versions saved in History, with the documents and files each holds. Only deleting a version frees them. */
  versions: { count: number; bytes: number };
  /** What freeing up space would do; null when there is nothing to free. */
  reclaim: ReclaimPlan | null;
  /** Why space cannot be freed right now, if so. */
  blocked?: string;
}

/** Exports are written as a new folder or a single ZIP file. */
export type ExportFormat = 'folder' | 'zip';

export interface ExportResult {
  ok: boolean;
  path?: string;
  message: string;
  warnings: string[];
  /** A failed website build: a report of everything it said, for the author to read and copy into a support request. */
  details?: string;
  revision?: number;
  previewUrl?: string;
  /** The library image the export stopped for, so the author can open it in Assets. */
  assetId?: string;
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

/** edit: the AI may change the site. ask: a read-only question; the AI reads the site and changes nothing. */
export type ChatMode = 'edit' | 'ask';

export interface ChatContext {
  pageId: string;
  pageTitle: string;
  selection: ElementRef | null;
  selectionLabel: string | null;
  /**
   * The component the author was editing everywhere when the request was sent. The request is then about that
   * component's design and every placement of it: `selection` is null for the whole design or one of its own nodes,
   * and `pageId` is only the page the editor showed it on. Absent for a request about the site.
   */
  component?: { id: string; name: string };
  viewport: number;
  /** Library images the author attached to the request, by asset ID. The AI is told their IDs and what the library says about them (name, size, description, alt text), never the pictures or their files. */
  assetIds?: string[];
  /** Absent in messages sent before questions existed, which were all edits. */
  mode?: ChatMode;
}

/** A content field the AI located while answering a question, opened from the answer with "Open in inspector". */
export interface FieldLocation {
  owner: OwnerRef;
  /** The placed component the field belongs to. */
  nodeId: string;
  prop: string;
  /** For a field of one list item: the item, and its field. */
  itemId?: string;
  field?: string;
  /** The Inspector labels that led to it when it was located: page, component, Content, group or list, item, field. */
  path: string[];
}

/** A library image named in a conversation, as it was then: its asset ID tells same-named images apart. */
export interface ChatImageRef {
  assetId: string;
  name: string;
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
    /** The turn was a read-only question: it read the site and could not change it. */
    ask?: boolean;
    /** Fields the AI located for the answer, each offered as "Open in inspector". */
    locations?: FieldLocation[];
  };
  /** Every question the assistant asked during this turn, in the order asked. */
  questions?: ChatQuestion[];
  /** The only question of a turn stored before `questions` existed; read through `turnQuestions`. */
  question?: ChatQuestion;
  /** A request's attached library images, as they were when it was sent (its context holds their IDs). */
  images?: ChatImageRef[];
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
  /** Library images offered as choices, shown as pictures before the text choices. */
  images?: ChatImageRef[];
  /** The offered image the user chose; `answered` is then its name. */
  answeredAssetId?: string;
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
  /** With a status: what kind of request is running. A question never holds the project, so editing goes on. */
  mode?: ChatMode;
  text?: string;
  activity?: ChatActivity;
  message?: ChatMessage;
}

/** One file in an import review: what it is, and what importing it would add to Assets. */
export interface ImportReviewRow {
  path: string;
  name: string;
  bytes: number;
  /** The SHA-256 of the content a convert, offer or refuse row describes: a file that changes before the author confirms is skipped. */
  fingerprint?: string;
  /**
   * import: added as it is. convert: a photo browsers can't show (HEIC), always added as a web-sized copy.
   * offer: a large photo that can be added as a web-sized copy instead. refuse: can't be added here (`reason`).
   */
  action: 'import' | 'convert' | 'offer' | 'refuse';
  /** The file's format ("HEIC", "JPEG", "PNG") and displayed size, when they could be read. */
  format?: string;
  width?: number;
  height?: number;
  /** What a convert or offer produces: its format and displayed size. */
  copy?: { format: 'JPEG' | 'PNG' | 'JPEG or PNG'; width: number; height: number };
  /** offer: the original is too large to add as it is, so only the copy can be. */
  copyOnly?: boolean;
  /** refuse: why, and what to do instead. */
  reason?: string;
}

export interface ImportReview {
  /** Every file chosen, in order; rows say what each one would be. */
  paths: string[];
  rows: ImportReviewRow[];
}

/** What the author confirmed in an import review. */
export interface ImportChoices {
  /** The opening of the project the files were reviewed in (its snapshot's workspaceKey); any other refuses the import. */
  opening: string;
  /** The reviewed photos (convert or offer), with the fingerprint of what the review saw: one that has changed since is skipped. */
  files: Array<{ path: string; fingerprint: string; webCopy: boolean }>;
}

/** A theme pack that was found but not loaded, and why. */
export interface PackRefusal {
  dir: string;
  packId?: string;
  reason: string;
}

/** The theme packs loaded at startup, and those refused. */
export interface PackCatalogue {
  packs: ThemePack[];
  refused: PackRefusal[];
  /** Where a person installs packs. */
  userDir: string;
}

export interface BuilderApi {
  platform: string;
  app: {
    info(): Promise<{ version: string; platform: string; dev: boolean }>;
    /** The theme packs loaded at startup. The editor registers them before it first renders. */
    catalogue(): Promise<PackCatalogue>;
    /** A pack's preview image as a data URL, or null when it has none. */
    packPreview(packId: string, file: string): Promise<string | null>;
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
    /** Whether creating a project downloads website tools, checked the way setup checks it. */
    websiteTools(): Promise<WebsiteTools>;
    /** Open a project folder or project ZIP file; with no path the author chooses one (`folder`: a folder, on Windows and Linux). */
    open(dir?: string, opts?: { folder?: boolean }): Promise<{ ok: boolean; message?: string; needsTrust?: { dir: string; name: string } }>;
    /** Call off a project ZIP file being unpacked: the open then answers { ok: false } and nothing is left behind. */
    cancelOpen(): Promise<void>;
    trustAndOpen(dir: string): Promise<{ ok: boolean; message?: string }>;
    /** ok is false when the author chose to keep editing a change that could not be saved. */
    close(): Promise<{ ok: boolean }>;
    duplicate(): Promise<{ ok: boolean; message?: string; dir?: string }>;
    reveal(path?: string): Promise<void>;
  };
  project: {
    snapshot(): Promise<ProjectSnapshot | null>;
    /**
     * Read the project documents from disk now, as the file watcher does after a file is saved outside the app, so
     * an edit refused because its file changed on disk can be checked against what is there.
     */
    reloadFromDisk(): Promise<{ ok: boolean; message?: string }>;
    /** `opening` is the snapshot's workspaceKey of the project the change was made in: any other refuses it. */
    apply(batch: EditBatch, opts?: { label?: string; coalesceKey?: string; opening?: string }): Promise<ApplyResult>;
    /**
     * Copy page content as it is now, for a later `node.paste` with the returned clipboard ID: one node, or several
     * siblings together. `opening` is the snapshot's workspaceKey of the project it was pressed in: the copy is kept
     * there only, and refused once another project (or another opening of it) is open.
     */
    copy(pageId: string, nodeId: string | string[], expectedRevision: number, opening: string): Promise<{ ok: boolean; clipboardId?: string; message?: string }>;
    undo(): Promise<ApplyResult>;
    /**
     * Undo one history entry (`ApplyResult.entryId`) of the opening `workspaceKey`, for an Undo offered beside that
     * change. The newest entry is undone like Undo; an older one is reversed on its own as a new change when later
     * edits allow it, and refused with CONFLICT otherwise.
     */
    undoEntry(entryId: string, workspaceKey: string): Promise<ApplyResult>;
    redo(): Promise<ApplyResult>;
    /**
     * Choose files to import (the file chooser, unless `paths` are given) and say what importing each would produce,
     * without writing anything. Null when the chooser was closed or no project is open.
     */
    reviewImport(paths?: string[], only?: 'image' | 'font' | 'document'): Promise<ImportReview | null>;
    /**
     * Import files (the file chooser, unless `paths` are given). `choices` carries what the author confirmed in a
     * review: which photos become web-sized copies, and the opening the review was made in. `note` says what was
     * done differently from what was asked (a copy that would be no smaller), without anything having failed.
     */
    importAssets(paths?: string[], only?: 'image' | 'font' | 'document', choices?: ImportChoices): Promise<{ ok: boolean; assetIds: string[]; message?: string; note?: string }>;
    /** What a web-sized copy of a large library image would be, or null when none can be made from it. */
    webCopyPlan(assetId: string): Promise<{ format: 'JPEG' | 'PNG' | 'JPEG or PNG'; width: number; height: number } | null>;
    /**
     * Add a web-sized copy of a large library image to Assets, and with `replace` show it in every place the image
     * is used, in one change that can be undone. The original stays in Assets. `opening` is the snapshot's
     * workspaceKey the author asked in; any other refuses it.
     */
    makeWebCopy(assetId: string, opts: { replace: boolean; opening: string }): Promise<{ ok: boolean; assetId?: string; entryId?: string; revision?: number; message?: string }>;
    /** What private metadata an image asset's original carries, which website exports leave out. Null when it cannot be read. */
    photoMetadata(assetId: string): Promise<{ location: boolean; device: boolean } | null>;
    /** Find the file of a library image whose original is missing (a dialog, unless `path` is given). */
    locateAsset(assetId: string, path?: string): Promise<{ ok: boolean; message?: string }>;
    /** Make again the smaller copies a library image is missing. */
    regenerateAssetCopies(assetId: string): Promise<{ ok: boolean; message?: string }>;
    /** What the project of the opening `workspaceKey` takes on disk; null once another opening is current. */
    storage(workspaceKey: string): Promise<StorageInfo | null>;
    /** Carry out the reclaim `planKey` (from `storage`) in the opening `workspaceKey`, dropping the undo steps it named. */
    reclaimStorage(planKey: string, workspaceKey: string): Promise<{ ok: boolean; message?: string; freed?: number }>;
    /** Save the site as it is now as a named version, kept until it is deleted (opening `workspaceKey`). `missing`: files its documents name that are not in the folder. */
    saveVersion(name: string, workspaceKey: string): Promise<{ ok: boolean; message?: string; id?: string; missing?: string[] }>;
    /** What restoring saved version `id` would change now. */
    reviewVersion(id: string, workspaceKey: string): Promise<{ ok: boolean; message?: string; review?: VersionReview }>;
    /**
     * Restore saved version `id` as reviewed at `revision`, putting back the files the review listed: one Undo step for
     * the documents, after saving the work it replaces as a version. Anything else changed since is `stale`.
     */
    restoreVersion(id: string, revision: number, reviewed: { files: string[]; replaced: string[] }, workspaceKey: string): Promise<RestoreVersionResult>;
    /** Delete saved version `id`, freeing what only it held. */
    deleteVersion(id: string, workspaceKey: string): Promise<{ ok: boolean; message?: string; freed?: number }>;
    exportSource(format?: ExportFormat): Promise<ExportResult>;
    /**
     * Build the website. `published` is the IDs of the pages the author was shown as published: an export whose
     * snapshot would publish other pages stops instead, so a page shown as a draft is never published unseen.
     */
    exportStatic(format?: ExportFormat, published?: string[]): Promise<ExportResult>;
    retryPreview(): Promise<void>;
    /**
     * Prepare an isolated preview of one component (a definition of the project, or a component of the theme's
     * catalogue) with chosen variants and sample property values, for the preview server running now. `path` is the
     * address it is shown at; release the key once nothing shows it.
     */
    prepareComponentPreview(spec: unknown): Promise<PreparedComponentPreview>;
    releaseComponentPreview(key: string): Promise<void>;
    /**
     * The thumbnail of a project component in the opening `workspaceKey`, for Insert: from the editor's cache, else
     * photographed from its isolated preview (which can take a few seconds). `have` is the key of the thumbnail shown
     * now: while it is still current, the answer leaves out the picture.
     */
    componentThumb(definitionId: string, workspaceKey: string, have?: string): Promise<ComponentThumb>;
    repairDependencies(): Promise<void>;
    readSource(definitionId: string): Promise<{ source: string; hash: string; path: string; editable: boolean }>;
    generatedSource(kind: 'component' | 'page', id: string): Promise<string>;
    restoreGenerated(path: string): Promise<void>;
    resolveConflict(path: string, choice: 'keep' | 'restore'): Promise<{ ok: boolean; message?: string }>;
    /** Both versions of a file in conflict, to compare before choosing: SiteOrigin Builder's and the one on disk. */
    compareConflict(path: string): Promise<{ ok: boolean; builder?: FileText; disk?: FileText; message?: string }>;
    /** What a saved copy (`SavedCopy.id`) holds. */
    readSavedCopy(id: string): Promise<{ ok: boolean; content?: FileText; message?: string }>;
    /** Take a saved copy off the list in Project health. The file itself stays in the project's recovery folder. */
    dismissSavedCopy(id: string): Promise<{ ok: boolean; message?: string }>;
    unlock(): Promise<{ ok: boolean; message?: string }>;
    /** `workspaceKey` is the opening of the project the state belongs to (from its snapshot); any other is dropped. */
    saveLocalState(state: LocalWorkspaceState, workspaceKey: string): Promise<void>;
    validateSource(source: string): Promise<{ ok: boolean; errors: string[]; diagnostics: Array<{ message: string; line?: number; column?: number; severity: 'error' | 'warning' }> }>;
    /** Resolves once the writes queued for the project have finished: whether they all reached the disk, in the
     *  opening given (its snapshot's workspaceKey). */
    flush(opening?: string): Promise<boolean>;
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
    /**
     * Answer the run's waiting question with text, or with one of the images it offered; false when that question is
     * no longer waiting, the answer is blank, or the image was not offered or is no longer in the project.
     */
    answer(runId: string, questionId: string, answer: string | { assetId: string }): Promise<boolean>;
    undoTurn(runId: string): Promise<{ ok: boolean; message?: string }>;
    fixCode(source: string): Promise<{ ok: boolean; source?: string; explanation?: string; message?: string; cancelled?: boolean }>;
    /** Cancel an in-flight fixCode request. */
    cancelFix(): Promise<void>;
  };
  on(channel: 'project:changed', cb: (snap: ProjectSnapshot) => void): () => void;
  on(channel: 'project:closed', cb: () => void): () => void;
  on(channel: 'create:progress', cb: (p: ProgressEvent) => void): () => void;
  /** A project ZIP file is being unpacked into a new folder in `dir` (null: it finished, failed or was called off). */
  on(channel: 'projects:unpacking', cb: (u: { name: string; dir: string } | null) => void): () => void;
  on(channel: 'runtime:status', cb: (s: RuntimeState) => void): () => void;
  on(channel: 'ai:event', cb: (e: AiEvent) => void): () => void;
  /** The editor's Appearance, when Settings saves a new one. */
  on(channel: 'appearance', cb: (appearance: Appearance) => void): () => void;
  on(channel: 'inspect:request', cb: (req: { requestId: string; pageId: string; width: number }) => void): () => void;
  /** Show components in isolated preview frames, step by step, and answer with componentPreviewResult. */
  on(channel: 'component-preview:request', cb: (req: { requestId: string; steps: ComponentPreviewStep[] }) => void): () => void;
  /** A File menu command: confirm it with menuReceived(id); the same id may be offered again until then. */
  on(channel: 'menu:command', cb: (command: { cmd: string; id: number }) => void): () => void;
  /** The app is about to leave the project (close, switch, close the window, quit): settle edits, then answer with leaveResult. */
  on(channel: 'lifecycle:request', cb: (req: { requestId: string }) => void): () => void;
  /** Edit → Undo or Redo, chosen from the menu or reached by its key (`fromKey`) when nothing on the page took the key. */
  on(channel: 'menu:history', cb: (e: { action: 'undo' | 'redo'; fromKey: boolean }) => void): () => void;
  on(channel: 'input:key', cb: (k: { key: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }) => void): () => void;
  inspectResult(requestId: string, report: unknown): void;
  componentPreviewResult(requestId: string, results: ComponentPreviewResult[]): void;
  /** The screen shown now listens for File menu commands (menu:command): one waiting for the editor is sent. */
  menuReady(): void;
  /** The File menu command `id` arrived, so the main process stops offering it. */
  menuReceived(id: number): void;
  /** 'asking' while the author decides about a change that cannot be saved; then 'leave' or 'stay'. */
  leaveResult(requestId: string, answer: 'leave' | 'stay' | 'asking'): void;
  pathForFile(file: File): string;
}
