import type { ApplyResult, EditBatch } from './ops';
import type { ElementRef, OwnerRef, ProjectState } from './types';
import type { ThemeUpdates } from '@engine/theme-updates';
import type { LocalProviderSettings } from './local';
import type { ComponentPreviewMeasure, ComponentPreviewResult, ComponentPreviewStep, PreparedComponentPreview } from './component-preview';
import type { ComponentThumb } from './component-thumbs';
import type { ThemePack } from '@catalogue/pack';
import type { FontCoverage } from './font-scripts';
import type { Recipient, TurnModel } from './turn-model';

export type Appearance = 'system' | 'light' | 'dark';
export type ProviderId = 'openai' | 'anthropic' | 'local';

export interface RecentProject {
  dir: string;
  name: string;
  openedAt: string;
  /**
   * The project's own ID from its manifest, kept so an entry whose folder has gone can be told apart from another
   * project of the same name when the author finds where it went (#217). Absent on entries listed before it was kept.
   */
  projectId?: string;
  /**
   * Pinned by the author (#259): kept on the list however many other projects are opened after it, and shown above
   * the rest. Absent on an entry that is not pinned.
   */
  pinned?: boolean;
  missing?: boolean;
  /**
   * The project brief's description (#518), read from the project's folder when the list is asked for: never kept in
   * the settings. Absent when the project has none, or its folder is missing.
   */
  description?: string;
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

/**
 * A change to settings. Only the models named change. A local model given here is chosen for the server the patch
 * leaves saved; `local.modelsByServer` entries are added to the ones already kept.
 */
export type SettingsPatch = Omit<Partial<AppSettings>, 'ai'> & { ai?: Partial<Omit<AppSettings['ai'], 'local' | 'models'>> & { models?: Partial<AppSettings['ai']['models']>; local?: Partial<LocalProviderSettings> } };

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
  /**
   * Local only: the last thing this app session learned about the saved server and model, from a model list, a
   * connection test or a chat request. Absent until something has been tried, and reset when the server, the
   * model or the key changes.
   */
  check?: LocalCheck;
}

/** Whether the local model answered the last time it was asked. A failure says where it failed. */
export type LocalCheck = { ok: true } | { ok: false; stage: 'server' | 'chat'; message: string };

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  owner?: { kind: string; id: string };
  nodeId?: string;
  /** Where in its owner the problem is (see the engine's Diagnostic): for a site setting, its field, as `favicon`. */
  site?: string;
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
  entries: Array<{
    id: string;
    label: string;
    source: string;
    time: string;
    applied: boolean;
    runId?: string;
    /** The AI run this step took back on its own, keeping the edits made after it (issue 164). */
    revertsRunId?: string;
  }>;
  /** AI runs whose step History has let go, and whether it was applied or undone when it went (issue 276). */
  droppedRuns?: Record<string, 'applied' | 'undone'>;
}

/**
 * One thing a History step changed, named the way the editor names it: `owner` is what it is part of (a page by its
 * title, "Site settings", "Header"), `property` what changed there. `before` and `after` are the values as they were
 * and became, absent when there was none (a page added has no `before`); a change with neither has no single value
 * to show, such as a page's content (`detail` then says how much changed).
 */
export interface StepChange {
  owner: string;
  property: string;
  change: 'added' | 'removed' | 'changed';
  before?: string;
  after?: string;
  detail?: string;
}

/**
 * A change made after an AI turn, and how it stands with taking that turn back on its own: `depends` when it changed
 * something the turn changed or made (a page it added) or relies on it (a link to that page), so it can only go back
 * with the turn; `separate` when it did neither. `reason` says why it depends.
 */
export interface TurnLaterChange {
  entryId: string;
  label: string;
  source: string;
  time: string;
  changes: StepChange[];
  relation: 'depends' | 'separate';
  reason?: string;
}

/** What an AI turn's History step changed, what came after it, and whether it can be taken back on its own (issue 164). */
export interface AiTurnReview {
  entryId: string;
  runId: string;
  label: string;
  /** The revision this was worked out at: a revert passes it back, and a project changed since is refused. */
  revision: number;
  /** History as it stood then, passed back the same way: steps recorded or let go since change what this says. */
  history: string;
  /** The turn's step is applied in History. */
  applied: boolean;
  /** The later step that already took the turn back on its own, while it is applied. */
  revertedBy?: { entryId: string; label: string };
  changes: StepChange[];
  /** History no longer holds the versions the turn's step names, so what it changed can't be shown. */
  detailsLost?: boolean;
  /** The applied changes made after it, oldest first. */
  later: TurnLaterChange[];
  /** Undone changes after History's position, which any new change (a revert too) leaves no longer redoable. */
  redoable: number;
  /** Whether the turn can be taken back on its own, keeping every later change; otherwise why not. */
  revert: { ok: true } | { ok: false; reason: string };
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
  /** The element last selected on each page, by page ID, so a page opened again resumes there (lib/page-place). */
  pagePlaces?: Record<string, ElementRef>;
}

export interface CreateProjectOptions {
  name: string;
  parentDir: string;
  starter: 'business' | 'blank';
  sampleImages: boolean;
  /** Names this attempt in its progress events, so a dialog follows only its own (another may still be running). */
  attempt?: string;
}

/** A copy of the open project, made in `parentDir` in a folder named after `name` (#176). */
export interface DuplicateProjectOptions {
  /** The copy's own name, shown in Recent projects and the toolbar; the site's visitor-facing name is kept. */
  name: string;
  parentDir: string;
  /** The snapshot's workspaceKey of the opening Duplicate was chosen in: any other opening refuses it. */
  opening: string;
}

/** Where a refused Duplicate belongs in its dialog: beside the name, beside the folder, or for the whole form. */
export type DuplicateProjectResult = { ok: true; dir: string; name: string } | { ok: false; field: 'name' | 'location' | 'form'; message: string };

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

/**
 * Where the author fixes something an export note, Project health or an SEO finding names: a placed contact form's
 * settings (the setting is found when it is opened, since the form's service may have changed since), a field of Site
 * details, a field of a page's Search & sharing settings, a field of a post (its text, at a picture when `picture`
 * numbers one as the writer does, from 1), or an element of a page, the shared header or footer, or a collection's
 * layout (shown on `entryId`'s page).
 */
export type EditorDestination =
  | { kind: 'form'; owner: OwnerRef; nodeId: string; setting: 'connection' | 'fieldKeys' | 'fieldChoices' | 'formName'; itemId?: string }
  | { kind: 'site'; field: 'baseUrl' | 'favicon' | 'socialImage' | 'identity' | 'logo' | 'sameAs' | 'llmsTxt' | 'webmcp' | 'crawlerPolicy' }
  | { kind: 'pageSeo'; pageId: string; field: 'title' | 'description' | 'noindex' | 'socialImage' | 'structuredData' }
  | { kind: 'entry'; collectionId: string; entryId: string; field: 'title' | 'excerpt' | 'seoTitle' | 'seoDescription' | 'body'; picture?: number }
  | { kind: 'element'; owner: OwnerRef; nodeId: string; entryId?: string };

/** One note about an export, in the order the export said it, with where to fix what it describes when it can be fixed. */
export interface ExportNote {
  message: string;
  destination?: EditorDestination;
}

export interface ExportResult {
  ok: boolean;
  path?: string;
  message: string;
  warnings: string[];
  /** The warnings again, with where to fix the ones that can be fixed in the editor. Absent from older results. */
  notes?: ExportNote[];
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
  /** What the export said about what it delivered, kept so the author can come back to it after fixing something. */
  notes?: ExportNote[];
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export type RunStatus = 'preparing' | 'running' | 'awaiting-input' | 'validating' | 'repairing' | 'stopping' | 'completed' | 'no-changes' | 'cancelled' | 'failed' | 'conflicted';

/** edit: the AI may change the site. ask: a read-only question; the AI reads the site and changes nothing. */
export type ChatMode = 'edit' | 'ask';

/** How far an edit on a page may reach: the selected element, the page, or the whole site. */
export type ChatEditScope = 'selection' | 'page' | 'site';

export const CHAT_EDIT_SCOPES: readonly ChatEditScope[] = ['selection', 'page', 'site'];

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
  /**
   * What an edit on a page may change, as the author chose it: the selected element, the page (`pageId`, its sections
   * and its own settings), or the whole site. A page or site request is sent without its selection. Absent in
   * questions, in requests about a component edited everywhere, and in requests sent before the scope could be chosen,
   * which were limited to their selection when they had one and could change the whole site otherwise.
   */
  scope?: ChatEditScope;
  viewport: number;
  /** Library images the author attached to the request, by asset ID. The AI is told their IDs and what the library says about them (name, size, description, alt text), never the pictures or their files. */
  assetIds?: string[];
  /** Absent in messages sent before questions existed, which were all edits. */
  mode?: ChatMode;
  /** What the request is for, when the editor says: "component" builds a new project component (Create component). */
  task?: 'component';
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
  /**
   * The provider and model that received this turn's request, fixed when the run started. Absent on user messages,
   * on turns that never reached a model, and on turns stored before it existed; read through `readTurnModel`.
   */
  model?: TurnModel;
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
    /**
     * The request failed because of the AI setup, not the request: fixed in AI settings (`settings`), or with a new
     * API key (`key`). Either way the same request can be sent again once it is.
     */
    repair?: 'settings' | 'key';
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
  /** The author named it: its title is theirs, and its first request never replaces it. */
  named?: boolean;
  createdAt: string;
  messages: ChatMessage[];
}

/** A stored conversation as Earlier conversations lists it (see shared/conversations). */
export interface ConversationSummary {
  id: string;
  title: string;
  named?: boolean;
  createdAt: string;
  /** Its newest message: the list puts the conversations continued most recently first. */
  updatedAt: string;
  /** Every request the author wrote in it, oldest first: shown to tell it apart, and searched. */
  prompts: string[];
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
/** An imported font file, for the editor's samples. */
export interface FontFileData {
  bytes: Uint8Array;
  /** What it covers, from its character map; null when that can't be read. */
  coverage: FontCoverage | null;
}

/** A component saved as a package file (see exportComponent). */
export interface ComponentExportResult {
  ok: boolean;
  path?: string;
  notes?: string[];
  message?: string;
}

/** A component package imported (see importComponent), with the history entry that undoes it. */
export interface ComponentImportResult {
  ok: boolean;
  definitionId?: string;
  name?: string;
  entryId?: string;
  /** The project's revision once it landed. */
  revision?: number;
  message?: string;
}

/** A component in the personal library (#372), kept on this computer for every project (see savedComponents). */
export interface SavedComponent {
  id: string;
  /** The saved copy listed: inserting or removing names it, so a copy saved since is never the one acted on. */
  digest: string;
  name: string;
  description?: string;
  /** How it goes into a page: as one of the page's sections, or as an element inside a layout. */
  role: 'section' | 'element';
  /**
   * It would bring code components into the project it was listed for (code that project's theme doesn't already
   * have): listed only in Developer mode, and inserted only after the author says the code may come in.
   */
  code: boolean;
  savedAt: string;
  /** The name of the project it was saved from. */
  from?: string;
}

/** A component saved to the personal library (see saveComponentToLibrary). */
export interface SaveToLibraryResult {
  ok: boolean;
  id?: string;
  name?: string;
  /** It replaced the copy saved from the same component before. */
  replaced?: boolean;
  /** What the saved copy leaves out (links to this site's pages, say). */
  notes?: string[];
  message?: string;
}

/** Where a saved component is inserted: the place Insert worked out for its role (see InsertAt). */
export interface SavedInsertPlace {
  owner: OwnerRef;
  parentId: string | null;
  slot?: string;
  index?: number;
}

/** A saved component inserted (see insertSavedComponent): imported and placed as one change. */
export interface SavedInsertResult extends ComponentImportResult {
  /** The placement made, to select. */
  nodeId?: string;
  /** The saved component is no longer in the library, or was saved again: the list is out of date. */
  gone?: boolean;
}

/** Where posts are imported from (#399): a WordPress export (.xml) or a folder of Markdown posts. */
export type PostImportKind = 'wordpress' | 'markdown';

/** One post as the import's review shows it, before anything is imported. */
export interface PostImportPreviewPost {
  title: string;
  /** Where it came from: its file, or its title in the export. */
  from: string;
  date: string;
  draft: boolean;
  /** Why a post published at the source arrives as a draft. */
  draftReason?: string;
  route: string;
  /** The slug it had, when it takes a numbered one because its address is taken. */
  wantedSlug?: string;
  /** The old address kept working for it. */
  redirectFrom?: string;
  pictures: number;
  categories: string[];
  tags: string[];
  /** What reading it left out or changed, in plain words. */
  notes: string[];
}

/** What importing the chosen posts would do: shown to the author, who imports them or not (see commitPostImport). */
export interface PostImportPreview {
  /** Names this review: only it can be imported, and only once. */
  id: string;
  kind: PostImportKind;
  /** The chosen file or folder's name. */
  source: string;
  /** The old site's address, when the export says. */
  site?: string;
  collection: { name: string; route: string; create: boolean };
  posts: PostImportPreviewPost[];
  /** Pictures found, to be added to the library. */
  pictures: number;
  /** Pictures the posts show that are not in the chosen folder, with why. */
  missing: Array<{ post: string; ref: string; problem: string }>;
  newTerms: { categories: string[]; tags: string[] };
  /** Old addresses kept working. */
  redirects: number;
  /** What is not imported at all. */
  skipped: string[];
  /** What stops the import: nothing can be imported while there is one. */
  problems: string[];
}

/** A review of posts to import, or why there is none. Neither: the chooser was closed. */
export type PostImportReviewResult = { ok: true; preview: PostImportPreview } | { ok: false; message?: string };

/** Posts imported (see commitPostImport), with the history entry that undoes them. */
export interface PostImportResult {
  ok: boolean;
  imported?: number;
  /** The history entry that undoes the import. */
  entryId?: string;
  revision?: number;
  /** The first imported post's entry, to open it. */
  firstEntryId?: string;
  /** What did not come through (a picture the library refused), in plain words. */
  notes?: string[];
  message?: string;
}

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
    /** Pin a listed project so it stays on the list and above the rest, or unpin it (#259); false if it is not listed. */
    pinRecent(dir: string, pinned: boolean): Promise<boolean>;
    create(opts: CreateProjectOptions): Promise<{ ok: boolean; message?: string }>;
    cancelCreate(): Promise<void>;
    /** Whether creating a project downloads website tools, checked the way setup checks it. */
    websiteTools(): Promise<WebsiteTools>;
    /**
     * Open a project folder or project ZIP file; with no path the author chooses one (`folder`: a folder, on Windows and
     * Linux). `replaces` is a missing recent entry's folder: once the chosen project opens, the entry is dropped if it
     * listed the same project (#217). Pass it on to trustAndOpen when the project asks for trust first.
     */
    open(dir?: string, opts?: { folder?: boolean; replaces?: string }): Promise<{ ok: boolean; message?: string; needsTrust?: { dir: string; name: string } }>;
    /** Call off a project ZIP file being unpacked: the open then answers { ok: false } and nothing is left behind. */
    cancelOpen(): Promise<void>;
    trustAndOpen(dir: string, opts?: { replaces?: string }): Promise<{ ok: boolean; message?: string }>;
    /** ok is false when the author chose to keep editing a change that could not be saved. */
    close(): Promise<{ ok: boolean }>;
    /** Copy the open project's source to a new folder, which is trusted and listed in Recent projects; the open project stays open. */
    duplicate(opts: DuplicateProjectOptions): Promise<DuplicateProjectResult>;
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
    /** What an AI turn's History step changed and what came after it (issue 164). It never writes. */
    reviewAiTurn(entryId: string, workspaceKey: string): Promise<{ ok: boolean; message?: string; review?: AiTurnReview }>;
    /** Take an AI turn back on its own, keeping every later change, as reviewed at `expected.revision` (issue 164). */
    revertAiTurn(entryId: string, expected: { revision: number; history: string }, workspaceKey: string): Promise<ApplyResult>;
    redo(): Promise<ApplyResult>;
    /**
     * Step History of the opening `workspaceKey` to an entry chosen in it, in one change: `undo` undoes that entry and
     * every applied one after it, `redo` redoes every undone entry up to and including it. Refused with CONFLICT when
     * the entry has gone or History already stands past it that way, and with STALE_REVISION once History is not as
     * it was shown (`expected`): the project has moved on from its revision, or the step no longer takes `count` changes.
     */
    stepHistory(entryId: string, direction: 'undo' | 'redo', expected: { revision?: number; count?: number }, workspaceKey: string): Promise<ApplyResult>;
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
    /**
     * Save a project component as a package file another project can import, where the author chooses. `notes` says
     * what the package leaves out. Neither `ok` nor a message: the chooser was closed.
     */
    exportComponent(definitionId: string): Promise<ComponentExportResult>;
    /** Import a component package the author chooses, as one change: the component, what it needs, its styles and images. */
    importComponent(): Promise<ComponentImportResult>;
    /**
     * The personal component library (#372), for the project open as `opening`: whether each would bring code into it
     * is worked out for that project. Empty when that project is no longer open.
     */
    savedComponents(opening: string): Promise<SavedComponent[]>;
    /** Save a project component of the project open as `opening` to the personal library, replacing its earlier copy. */
    saveComponentToLibrary(definitionId: string, opening: string): Promise<SaveToLibraryResult>;
    /** Take the saved copy `digest` of a component out of the personal library: `changed` when it was saved again since. */
    removeSavedComponent(id: string, digest: string): Promise<'removed' | 'changed' | 'gone'>;
    /**
     * Insert a saved component into the project open as `opening`, still at `revision`, at `place`, going in as its
     * role: its package is imported and placed as one change, after the author says any code it brings may come in.
     */
    insertSavedComponent(id: string, digest: string, place: SavedInsertPlace, opening: string, revision: number): Promise<SavedInsertResult>;
    /**
     * Choose a WordPress export or a folder of Markdown posts and read it, writing nothing: what importing it into the
     * project open as `opening` would do. The review holds until it is imported, cancelled, or another takes its place.
     */
    reviewPostImport(kind: PostImportKind, opening: string): Promise<PostImportReviewResult>;
    /** Import the posts of review `id`, as one change, while the project is still as it was reviewed. */
    commitPostImport(id: string, opening: string): Promise<PostImportResult>;
    /** Forget review `id`: nothing of it is imported. */
    cancelPostImport(id: string): Promise<void>;
    /**
     * An imported font file's bytes and the alphabets it covers, for samples drawn in the file itself. Null once the
     * project (`opening`, its workspace key) has closed, or when the file can't be read.
     */
    fontFile(assetId: string, opening: string): Promise<FontFileData | null>;
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
    /** `stage`, for a local server: whether reaching it and finding the model failed, or the chat request. */
    testProvider(provider: ProviderId, key?: string, model?: string): Promise<{ ok: boolean; message: string; stage?: 'server' | 'chat' }>;
    /** Models the saved local server reports. */
    /** `server`: the saved address that was asked, which the list belongs to. */
    localModels(): Promise<{ ok: boolean; models: string[]; message?: string; server?: string }>;
    conversations(): Promise<{ active: Conversation; list: ConversationSummary[] }>;
    newConversation(): Promise<Conversation>;
    openConversation(id: string): Promise<Conversation>;
    /**
     * Name a stored conversation (or the open one). `workspaceKey` is the opening of the project it was renamed in;
     * main refuses any other. Resolves with its new title.
     */
    renameConversation(id: string, title: string, workspaceKey: string): Promise<{ id: string; title: string }>;
    /** Delete one stored conversation; the open one is replaced by a new conversation. Resolves with the open one. */
    deleteConversation(id: string, workspaceKey: string): Promise<Conversation>;
    /** `workspaceKey` is the opening of the project the user confirmed this in; main refuses any other. */
    clearHistory(workspaceKey?: string): Promise<Conversation>;
    /**
     * `conversationId` is the conversation the message was written in; main refuses it if another one is open.
     * `recipient` is the model the composer named for it: a run that would go to another one sends nothing.
     */
    send(text: string, context: ChatContext, conversationId?: string, recipient?: Recipient): Promise<{ ok: boolean; runId?: string; message?: string }>;
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
  on(channel: 'component-preview:request', cb: (req: { requestId: string; steps: ComponentPreviewStep[]; measure?: ComponentPreviewMeasure }) => void): () => void;
  /** The main process no longer waits for this batch: start no more of its steps. */
  on(channel: 'component-preview:cancel', cb: (req: { requestId: string }) => void): () => void;
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
