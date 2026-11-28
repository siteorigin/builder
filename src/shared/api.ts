import type { ReviewEditionManifest, ReviewEditionResult, ReviewPage, ReviewSheetResult } from './review-edition';
import type { ApplyResult, EditBatch, Op } from './ops';
import type { ElementRef, OwnerRef, ProjectState } from './types';
import type { ThemeUpdates } from '@engine/theme-updates';
import type { LocalProviderSettings } from './local';
import type { ShortcutSettings } from './shortcuts';
import type { FirstStepsRecord } from './first-steps';
import type { ComponentPreviewMeasure, ComponentPreviewResult, ComponentPreviewStep, PreparedComponentPreview } from './component-preview';
import type { ComponentThumb } from './component-thumbs';
import type { ProjectChange } from './project-feed';
import type { ThemePack } from '@catalogue/pack';
import type { FontCoverage } from './font-scripts';
import type { Recipient, TurnModel } from './turn-model';
import type { EarlierSummary } from './earlier-summary';
import type { SessionDuration } from './live/expiry';
import type { GuestRole } from './live/limits';
import type { ElementTarget, Participant, Presence, Spotlight } from './live/messages';
import type { LiveEditBatch } from './live/capabilities';
import type { LiveApplyResult, LiveProjectSnapshot } from './live/snapshot';
import type { LiveAiAccess, LiveAiContext, LiveAiTurn } from './live/ai';
import type { LiveNoteResult, LiveNotes, NoteDraft } from './live/notes';

export type Appearance = 'system' | 'light' | 'dark';
export type ProviderId = 'openai' | 'anthropic' | 'local';

/** What a page measurement in the preview is limited to. */
export interface InspectLayoutOptions {
  /** Measure only these elements of the page and what is inside them (inspect_layout with refs). */
  targets?: ElementRef[];
  /** List only the findings on these elements (validate_project narrowed to them). */
  focus?: string[];
}

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
  /**
   * The site's home-screen icon (static/apple-touch-icon.png, drawn from its favicon or monogram on every save) as a
   * PNG data URL, read from the folder when the list is asked for. Absent when the folder is missing or has none.
   */
  icon?: string;
}

export interface AppSettings {
  appearance: Appearance;
  /** Shows code components and source editing. Off by default: most users never need code. */
  developerMode: boolean;
  /**
   * Saved versions are stored as snapshots of the whole site in a Git repository of the project's own
   * (`.siteorigin/versions.git/`), written by the bundled Git. Off by default: versions then use the plain store, and no
   * repository is made. Versions saved either way stay listed and restorable whichever this is.
   */
  gitSnapshots: boolean;
  /**
   * Advanced: the live session relay to use instead of the production one, as a normalized http(s) origin, or null
   * for the default. `SITEORIGIN_LIVE_RELAY_URL` wins over it (see shared/live/relay-url.ts).
   */
  liveRelayUrl: string | null;
  /** Shortcuts the author has reassigned, as `shared/shortcuts.ts` writes them. */
  shortcuts: ShortcutSettings;
  ai: {
    provider: ProviderId | null;
    models: Record<ProviderId, string>;
    local: LocalProviderSettings;
    sendOnEnter: boolean;
    setupAcknowledged: boolean;
  };
}

/** What Git the app has for saved versions: the bundled one, which needs nothing installed, and the computer's own. */
export interface GitRuntimeInfo {
  bundled: { engine: 'isomorphic-git'; ready: true; version: string } | { engine: 'isomorphic-git'; ready: false; reason: string };
  system: { status: 'present'; path: string; version: string } | { status: 'missing' } | { status: 'unusable'; path: string; reason: 'failed' | 'timeout' | 'unrecognised' };
}

/**
 * A change to settings. Only the models named change. A local model given here is chosen for the server the patch
 * leaves saved; `local.modelsByServer` entries are added to the ones already kept.
 */
export type SettingsPatch = Omit<Partial<AppSettings>, 'ai' | 'shortcuts'> & {
  ai?: Partial<Omit<AppSettings['ai'], 'local' | 'models'>> & { models?: Partial<AppSettings['ai']['models']>; local?: Partial<LocalProviderSettings> };
  /** A binding that cannot be used, or that another shortcut has, is refused with the reason. */
  shortcuts?: Partial<ShortcutSettings>;
};

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

/**
 * What a web-sized copy of a large library image would be, measured by making it: its format and size, `lighter:
 * false` when it would hardly be lighter than the original (so none is offered), or null when none can be made.
 */
export type WebCopyPlan = { format: 'JPEG' | 'PNG'; width: number; height: number } | { lighter: false } | null;

/** A library image whose files are not in the project folder: its original, and which listed copies. */
export interface MissingAssetFiles {
  assetId: string;
  original: boolean;
  variants: string[];
}

/** How many steps History keeps: past this, each new step lets the oldest go. */
export const HISTORY_LIMIT = 100;

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
    /** The revision the step last changed the project at: a step that later edits joined has a newer one. */
    revision: number;
    applied: boolean;
    runId?: string;
    /** The AI run this step took back on its own, keeping the edits made after it (issue 164). */
    revertsRunId?: string;
    /** The live-session guest who made this step, by the name the host let them in under (#765). */
    guestName?: string;
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
  /** Saved by the app, not the author: before a restore, as the way back to the work it replaced, or after one. */
  auto: boolean;
  /** Saved by the app after a restore, with Git snapshots on: the site as that restore left it (#1155). */
  restored?: boolean;
  /** How many pages it holds. */
  pages: number;
  /**
   * What deleting it frees: what no other saved version also holds. Null for a version saved with Git snapshots on,
   * whose snapshot stays in the project's version history when it is deleted from the list: at most the few files kept
   * beside the history (an external source's settings) are freed.
   */
  bytes: number | null;
  /** Files its documents name that were missing from the project folder when it was saved. */
  missing: string[];
}

/** The saved versions of the open project. */
export interface VersionsInfo {
  /** Newest first. */
  list: SavedVersionInfo[];
  /** What all saved versions take together, each file counted once. */
  bytes: number;
  /**
   * Of `bytes`, what the project's version history takes (versions saved with Git snapshots on): kept for good, since
   * deleting a version from the list leaves its snapshot there. Absent when the project has none.
   */
  historyBytes?: number;
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
  /**
   * With Git snapshots on: why the site as restored is not, or not yet, a saved version of its own, though the restore
   * itself is done (#1155).
   */
  notice?: string;
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
  /**
   * external: the file as it was edited outside the app; builder: SiteOrigin Builder's version; attempted: the version
   * an AI request tried to save before it was rolled back around the external edit.
   */
  side: 'external' | 'builder' | 'attempted';
  /** When it was saved, in milliseconds since 1970. */
  savedAt: number;
  /** Where the copy is, relative to the project folder. */
  file: string;
  /** The version had no file (an AI request that removed it): nothing was written to `file`. */
  removed?: boolean;
}

/** A version of a file as text to show, or why it is not shown as text. */
export type FileText = { state: 'text'; text: string } | { state: 'missing' } | { state: 'binary' } | { state: 'too-large' } | { state: 'unreadable' };

/** How a file conflict is settled: the file on disk kept, Builder's version restored, or a design's file made code. */
export type ConflictChoice = 'keep' | 'restore' | 'convert';

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
  /**
   * Files changed outside the app. canonical: a project document (keep or restore); generated: a derived file (restore,
   * or, for a design's own file, `convert` into a code component in the design's place).
   */
  conflicts: Array<{ path: string; reason: string; kind: 'canonical' | 'generated'; builderMissing?: boolean; aiRun?: boolean; convert?: { definitionId: string } }>;
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
  /** A save that failed, until a later one succeeds (or, when unfinished, until the project is reopened). */
  saveFailure?: SaveFailure | null;
}

/**
 * A save that did not reach the disk. `failed`: nothing of it was written, so the project is as it was before it and
 * the next save that succeeds clears this. `unfinished`: part of it may have been written, so nothing more is saved
 * until the project is closed and reopened, which finishes it.
 */
export interface SaveFailure {
  kind: 'failed' | 'unfinished';
  /** The change that was being saved, as history names it, when known. */
  label?: string;
  /** What went wrong, in the system's words. */
  message: string;
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
  /** A new Business site's Get started list (shared/first-steps): what the starter made, and how far the author is. */
  firstSteps?: FirstStepsRecord;
}

export interface CreateProjectOptions {
  name: string;
  parentDir: string;
  starter: 'business' | 'blank' | 'showcase';
  sampleImages: boolean;
  /** The theme the site starts with; without one, the default theme. It can be changed any time in Site styles. */
  themeId?: string;
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

/**
 * Where a refused Duplicate belongs in its dialog: beside the name (none given, too long, or a folder by that name
 * already there, which another name or folder answers), beside the folder (one that cannot be used, which only
 * another folder answers), or for the whole form.
 */
export type DuplicateProjectResult = { ok: true; dir: string; name: string } | { ok: false; field: 'name' | 'location' | 'form'; message: string };

/**
 * A project to ask about before its website tools run, and why it is asked: Builder has never trusted it in this folder
 * (`new`), trusted it here before its setup files changed (`changed`), or has just unpacked it from a ZIP file into a
 * new folder (`unpacked`).
 */
export type TrustRequest = { dir: string; name: string; reason: 'new' | 'changed' | 'unpacked' };

/**
 * A project ZIP file being unpacked: into a new folder in `dir`, named `folder` unless that name is taken (then a
 * number follows it), with `done` of its `total` files written so far.
 */
export type Unpacking = { name: string; dir: string; folder: string; done: number; total: number };

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
  /**
   * Named versions saved in History, with the documents and files each holds. Only deleting a version frees them, but
   * for `historyBytes` (as VersionsInfo), which deleting never frees.
   */
  versions: { count: number; bytes: number; historyBytes?: number };
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
  | { kind: 'site'; field: 'baseUrl' | 'favicon' | 'socialImage' | 'identity' | 'logo' | 'sameAs' | 'llmsTxt' | 'webmcp' | 'crawlerPolicy' | 'redirects' }
  | { kind: 'pageSeo'; pageId: string; field: 'title' | 'description' | 'noindex' | 'socialImage' | 'structuredData' | 'pageTitle' }
  | { kind: 'entry'; collectionId: string; entryId: string; field: 'title' | 'excerpt' | 'seoTitle' | 'seoDescription' | 'body'; picture?: number }
  | { kind: 'element'; owner: OwnerRef; nodeId: string; entryId?: string }
  /** One field of a placement's content: a property, one field of an object (`field`), or of a list item (`itemId` and `field`). */
  | { kind: 'prop'; owner: OwnerRef; nodeId: string; prop: string; itemId?: string; field?: string };

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
  /**
   * A finished website's hosting guidance (how its host shows the not-found page): information for the success screen,
   * never one of the warnings, which are what the author may need to fix.
   */
  hosting?: string;
  /** The library image the export stopped for, so the author can open it in Assets. */
  assetId?: string;
  /** A review build's base path (the site's subfolder, or ''), from the snapshot it was built from: where to serve it. */
  basePath?: string;
  /** A review build's pages, with their titles, from the snapshot it was built from: what a review edition can capture. */
  pages?: ReviewPage[];
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

export type RunStatus = 'preparing' | 'running' | 'awaiting-input' | 'validating' | 'repairing' | 'stopping' | 'completed' | 'partial' | 'no-changes' | 'cancelled' | 'failed' | 'conflicted';

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
  /**
   * The post open in the Posts workspace when the request was sent (written, or previewed), with its title then. The
   * request is about that post: it may change only it until the author allows more, whatever page lies under the
   * writer, so it is sent with no selection, component or scope. Absent for a request about a page or the site.
   */
  post?: { collectionId: string; entryId: string; title: string };
  /**
   * The collection layout open on the canvas when the request was sent (#679): its entry pages' layout, or with
   * `archive` its index layout, and the entry it was shown with (a sample, never what the request changes). The
   * request may change only that layout, so it is sent with no selection, component, post or scope. `name` is the
   * collection's name then, for the transcript.
   */
  template?: { collectionId: string; archive?: true; entryId?: string; name: string };
  viewport: number;
  /** Library images the author attached to the request, by asset ID. The AI is told their names and IDs alone, never the pictures or their files (search_assets reads what the library says about them). */
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

/**
 * Tokens a model request took, as the provider reported them. `inputTokens` is the whole prompt, whatever part of it
 * the provider read from its prompt cache (`cachedInputTokens`) or wrote to it (`cacheWriteTokens`, Anthropic's); each is
 * absent when the provider did not say.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
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
    /** The run's tokens in all, and each answered model turn's in order: null where the provider did not report them. */
    usage?: TokenUsage & { turns?: Array<TokenUsage | null> };
    /**
     * The request is not finished: the run stopped at a budget, or ended with requested work still missing. Set on
     * every `partial` result, whose valid work is kept as one undoable step, and on a `no-changes` one that made
     * nothing of what was asked. The user can ask either to continue.
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
    /**
     * Code the run wrote that the project does not keep, each version kept in the project's recovery folder (spec
     * 14.3): a source patch the checks refused (`rejected`), or one that landed in a run that was then undone because it
     * failed or was stopped (`reverted`). `path` is relative to the project folder.
     */
    sourceDrafts?: SourceDraft[];
  };
  /** Every question the assistant asked during this turn, in the order asked. */
  questions?: ChatQuestion[];
  /** The only question of a turn stored before `questions` existed; read through `turnQuestions`. */
  question?: ChatQuestion;
  /** A request's attached library images, as they were when it was sent (its context holds their IDs). */
  images?: ChatImageRef[];
  /**
   * The live-session collaborator the turn was for (#769), on both of its messages: its name as the host let it in, and
   * the admission it came under (a guest's later requests hear that admission's turns alone).
   */
  guest?: { name: string; id: string };
}

/** A version of a code component's source that an AI run wrote, kept after the project let it go. */
export interface SourceDraft {
  definitionId: string;
  /** The component's name when the source was written: a run that is undone may take the component with it. */
  name: string;
  path: string;
  reason: 'rejected' | 'reverted';
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
  /**
   * Set only by the app itself, never by the model: the question asks the user to allow an AI batch that changes where
   * contact forms send visitors' messages (#1130), and the editor shows it in its own dialog, each form's destination
   * before and after. `choices` are [keep, allow].
   */
  formRouting?: FormRoutingPrompt;
}

/**
 * What the app shows in its dialog before an AI batch changes where a contact form sends (engine/form-routing): each
 * affected form (or a design's defaults, or its code), and each of its settings that decides it, before and after.
 */
export interface FormRoutingPrompt {
  forms: Array<{
    /** The form and where it is, in the user's words (“Contact form” on “Home”). */
    title: string;
    rows: Array<{ label: string; before: string; after: string }>;
    /** Something the rows cannot say: that code decides where it sends. */
    note?: string;
  }>;
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
  /**
   * What the assistant hears of the messages before the replayed window, extended as messages leave it (see
   * shared/earlier-summary). Saved with the conversation, so it goes when the conversation is deleted or cleared.
   */
  earlierSummary?: EarlierSummary;
}

/** A stored conversation as Earlier conversations lists it (see shared/conversations). */
/**
 * A conversation as main has it now, read by its ID without opening it: the live thread while a request is filed in it
 * (its newest turn included, saved or not), otherwise its stored file. `run`: the request still going in this opening
 * of the project, in whichever conversation it was filed (`conversationId`), so a window reloaded on another thread
 * still knows it holds the app, and where to answer or stop it (#1125).
 */
export interface ConversationState {
  conversation: Conversation;
  run: { runId: string; status: RunStatus; mode: ChatMode; conversationId: string; saveable?: boolean } | null;
}

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
  /**
   * With an `awaiting-input` status: the author's held edits can be saved while it waits, without stopping it
   * (project.saveWhileAsking, #1281). Absent for the app's own question about where forms send.
   */
  saveable?: boolean;
  /**
   * With `text`: the turn's text, whole; or, with `at`, the piece it gained, which follows its first `at` characters
   * (the text sent before). A turn streams as pieces, so what is sent grows with the reply, not with its square.
   */
  text?: string;
  at?: number;
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
  /** The source gave no date: `date` is the day it was reviewed. */
  dateAssigned?: boolean;
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
  /** Old addresses that can't keep working (each post's note says why). */
  redirectsLost?: number;
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
  /** Whether the new blog's link joined the header menu; absent when none was asked for. */
  addedToNavigation?: boolean;
  /** The pictures that did not come through (the library refused them): the file, the posts that show it, and why. */
  notes?: Array<{ file: string; posts: string[]; reason: string }>;
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

// ---------------------------------------------------------------------------
// Hosting a live session (src/shared/live/ has the wire protocol; src/main/live/ the host)

/**
 * One live session, in the project opening it was started in. Every host command names it, so a command meant for a
 * session that has ended (or for another opening of the project) is refused rather than reaching the next one.
 */
export interface LiveRun {
  /** The snapshot's `workspaceKey` the session was started in. */
  workspaceKey: string;
  /** This session, of the ones started in that opening. */
  runId: string;
}

/** The room as the relay last confirmed it. Times are on the relay's clock, in milliseconds since the epoch. */
export interface LiveRoom {
  roomId: string;
  /** The link guests open, on the relay the session uses: `<relay>/s/<roomId>`. */
  inviteUrl: string;
  /** The project's name as guests are shown it. */
  projectName: string;
  duration: SessionDuration;
  startedAt: number;
  expiresAt: number;
  /** The relay's clock less this computer's, as last measured: the relay's time now is `Date.now() + relayClockOffsetMs`. */
  relayClockOffsetMs: number;
  /** A locked room turns away new join requests. */
  locked: boolean;
  /** Whether guests may leave pinned notes (#770): Allow guest notes, on until the host turns it off. */
  guestNotes: boolean;
  /** Everyone in the room: those waiting to be let in, and those admitted with their role and access. */
  participants: Participant[];
}

/**
 * What the host's live session is doing. `reconnecting`: the relay connection dropped and the host is taking the room
 * back; guests keep their places, but nothing reaches them until it does, and commands other than stop are refused.
 * `lastError`: the latest thing the relay refused, or, when idle, why the last session ended on its own (null when
 * the host ended it).
 */
export type LiveHostState =
  | { phase: 'idle'; lastError: string | null }
  | (LiveRun & { phase: 'starting' | 'stopping' })
  | (LiveRun & LiveRoom & { phase: 'active' | 'reconnecting'; previewReady: boolean; lastError: string | null; ai: Record<string, LiveAiGrant> });

/**
 * What the host lets one admitted guest do with its AI (#769), by guest ID in LiveHostState: off for every guest until
 * the host turns it on for a collaborator, and off again whenever it stops being one. `turnLimit` is how many requests
 * it may make while it is in the session (null: no limit), and `turnsUsed` how many it has made.
 */
export interface LiveAiGrant {
  allowed: boolean;
  turnLimit: number | null;
  turnsUsed: number;
}

/** Where a guest just pointed (#768). `seq` tells a new spotlight from one already shown. */
export interface LiveSpotlight {
  seq: number;
  spotlight: Spotlight;
}

/** A collaborator's edit just made (#768): the one element it changed, or null for more or other than one. */
export interface LiveActivity {
  seq: number;
  target: ElementTarget | null;
}

/**
 * Where the live session's collaborators are in the project, as each last said, by guest ID (`live:presence`), with
 * each guest's latest spotlight and each collaborator's latest edit while they are shown: sent whenever any of them
 * changes, and when a guest leaves, drops its connection, or stops being a collaborator.
 */
export interface LivePresence extends LiveRun {
  guests: Record<string, Presence>;
  spotlights: Record<string, LiveSpotlight>;
  activity: Record<string, LiveActivity>;
}

/** A guest asking to join, sent once when it starts waiting (`live:request`). */
export interface LiveJoinRequest extends LiveRun {
  roomId: string;
  guestId: string;
  displayName: string;
}

/**
 * Why this app's place in another computer's live session ended (#766): it left, the host turned it away or ended
 * the session, its access ran out, or the relay could not keep or find its place.
 */
export type RemoteEnding = 'left' | 'declined' | 'kicked' | 'expired-guest' | 'expired-session' | 'ended' | 'host-gone' | 'locked' | 'full' | 'replaced' | 'lost' | 'unavailable' | 'refused';

/**
 * Someone admitted to the live session this app is a guest in, as the relay lists them: with their place in the
 * session's palette, and whether their connection is up now.
 */
export interface RemoteParticipant {
  guestId: string;
  displayName: string;
  role: GuestRole;
  colorSlot: number;
  connected: boolean;
}

/** One join of a live session, so a late event from an earlier join never reaches the next. */
export interface RemoteJoin {
  joinId: string;
  /** The relay and room the invite link named. */
  relayUrl: string;
  roomId: string;
  displayName: string;
  /** Whether the host is connected to the relay now: while it is away, edits wait and the preview shows nothing new. */
  hostConnected: boolean;
  /** The connection to the relay dropped and this app is taking its place back. */
  reconnecting: boolean;
}

/**
 * This app as a guest in another computer's live session: the remote shell (#766). `joining`: asking the relay for a
 * place; `waiting`: in the waiting room until the host lets it in; `admitted`: editing (a collaborator) or watching (a
 * viewer) the host's project. `previewUrl` is this computer's own loopback address for the host's preview, once the
 * preview cookie is in place. Times are on the relay's clock: `relayClockOffsetMs` is the relay's less this computer's.
 * `ended` says why the last join ended, until the next.
 */
export type RemoteState =
  | { phase: 'idle'; ended: { reason: RemoteEnding; message: string } | null }
  | (RemoteJoin & { phase: 'joining' | 'waiting' })
  | (RemoteJoin & {
      phase: 'admitted';
      guestId: string;
      role: GuestRole;
      projectName: string;
      guestExpiresAt: number | null;
      sessionExpiresAt: number;
      relayClockOffsetMs: number;
      /** The host's preview, as the host says it is doing. */
      hostRuntime: RuntimeState['state'] | null;
      /** The project revision the host last said its preview serves: a page loaded now shows it or a later one. Null before it said. */
      previewRevision: number | null;
      previewUrl: string | null;
      /** A preview that could not be let in, until it is. */
      previewProblem: string | null;
      /** The host's project is too large to send whole over the relay; the editor shows the last one that fitted. */
      tooLarge: boolean;
      participants: RemoteParticipant[];
    });

/**
 * Where the others in the live session are, as each last said (`remote:presence`): the host, and collaborators by guest
 * ID, with each other collaborator's latest edit while it is shown (#768).
 */
export interface RemotePresence {
  joinId: string;
  host: Presence | null;
  guests: Record<string, Presence>;
  activity: Record<string, LiveActivity>;
}

export type RemoteJoinResult = { ok: true; state: RemoteState } | { ok: false; message: string };

/**
 * This app's own requests to the host's AI, as a collaborator in its live session (#769): whether the host allows them
 * and how many are left, the requests made in this join (kept on this computer only while it lasts), and the one
 * running now. Every request runs on the host's computer, with its AI provider.
 */
export interface RemoteAi {
  joinId: string;
  access: LiveAiAccess;
  turns: LiveAiTurn[];
  /** This app's request the host's AI is working on, until it ends. */
  activeRunId: string | null;
}

export type RemoteAiSendResult = { ok: true; runId: string } | { ok: false; message: string };

export type LiveStartResult = { ok: true; inviteUrl: string; state: LiveHostState } | { ok: false; message: string };
/** Whether a host command was sent: the relay's next roster or room state shows it taking effect. */
export type LiveCommandResult = { ok: true } | { ok: false; message: string };

/** An external source's settings as the Connect dialog saves them: `source.upsert`, whole. */
export type SourceSettingsDraft = Omit<Op<'source.upsert'>, 'type'>;

/**
 * The links in a source's records whose address an entry cannot keep (script, or a relative one with no page to read it
 * from): their words are kept as plain text. How many, how many records have one, and the titles of the first few of
 * those (none when a converter read them).
 */
export interface SourceDroppedLinks {
  count: number;
  records: number;
  titles: string[];
}

/** What a Test of a source's settings found: the first few records as the source sent them and as entries, and what a sync would do. */
export type SourceSampleResult =
  | { ok: true; raw: unknown[]; records: unknown[]; total: number; created: number; updated: number; unchanged: number; unpublished: number; removed: number; kept: number; droppedLinks?: SourceDroppedLinks }
  | { ok: false; message: string; code?: string };

/** What a sync of a source changed, or why it changed nothing. */
export type SourceSyncResult =
  | { ok: true; revision: number; created: number; updated: number; unchanged: number; unpublished: number; removed: number; kept: number; images: number; droppedLinks?: SourceDroppedLinks }
  | { ok: false; message: string; code?: string };

/** The manifest a code component's source is checked against in the code editor (see BuilderApi.project.validateSource). */
export interface SourceManifest {
  /** The component being edited, for its variant axes and, without `properties`, its stored properties. */
  definitionId?: string;
  /** The properties as edited, not yet saved (the editor's draft, which may not be complete). */
  properties?: Record<string, unknown>;
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
    /** The Git saved versions use (#1153): the bundled one, ready or why not, and the computer's own if it has one. */
    gitRuntime(): Promise<GitRuntimeInfo>;
    openExternal(url: string): Promise<void>;
    /** Which build this is, as Help > Copy Build Details copies it, to quote in a report. */
    buildDetails(): Promise<string>;
    /** Open the folder a person installs themes in, made if it is not there yet. Resolves with why it could not be
     *  opened, or '' when it was. */
    showThemesFolder(): Promise<string>;
    /** Quit the app, the normal way. */
    quit(): Promise<void>;
    /** While on, the app's menus take no keys, so Settings can record any key press as a shortcut (#750). */
    recordShortcut(on: boolean): Promise<void>;
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
    open(dir?: string, opts?: { folder?: boolean; replaces?: string }): Promise<{ ok: boolean; message?: string; needsTrust?: TrustRequest }>;
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
     * The project whole for an editor page that has just loaded, which the changes `project:changed` brings from then
     * on are made against (shared/project-feed.ts); null when none is open. The editor reads it through its transport.
     */
    feed(): Promise<ProjectChange | null>;
    /** The editor missed a change: the main process sends it the whole project on `project:changed`; false when none is open. */
    resync(): Promise<boolean>;
    /**
     * Read the project documents from disk now, as the file watcher does after a file is saved outside the app, so
     * an edit refused because its file changed on disk can be checked against what is there.
     */
    reloadFromDisk(): Promise<{ ok: boolean; message?: string }>;
    /** `opening` is the snapshot's workspaceKey of the project the change was made in: any other refuses it. */
    apply(batch: EditBatch, opts?: { label?: string; coalesceKey?: string; opening?: string }): Promise<ApplyResult>;
    /** Wait for a generated page to be served by the current preview before opening it. Null while the preview starts. */
    previewRouteReady(route: string, revision: number): Promise<boolean | null>;
    /**
     * Save a held edit while AI request `runId` waits for the author's answer, without stopping it (#1281). `base` is what
     * each field the edit writes held when the author made it: the edit lands only while every one still holds that, in
     * the project and where the request started, so stopping it later keeps the edit. Refused otherwise (CONFLICT, its
     * `details.held` saying why), and BUSY once the request no longer waits. `opening` as for apply.
     */
    saveWhileAsking(batch: EditBatch, opts: { runId: string; base: unknown[]; label?: string; opening?: string }): Promise<ApplyResult>;
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
    commitPostImport(id: string, opening: string, addToNavigation: boolean): Promise<PostImportResult>;
    /** Forget review `id`: nothing of it is imported. */
    cancelPostImport(id: string): Promise<void>;
    /**
     * An imported font file's bytes and the alphabets it covers, for samples drawn in the file itself. Null once the
     * project (`opening`, its workspace key) has closed, or when the file can't be read.
     */
    fontFile(assetId: string, opening: string): Promise<FontFileData | null>;
    /** Test an external source's settings against what it has now (#678): nothing is written and no picture fetched. */
    testSource(draft: SourceSettingsDraft, opening: string): Promise<SourceSampleResult>;
    /**
     * Save an external source's settings, once a Test of them passes now, over `base` (sourceFingerprint of the settings
     * the dialog was opened on; null for a new source) and nothing later.
     */
    saveSource(draft: SourceSettingsDraft, opening: string, base: string | null): Promise<{ ok: true; revision: number } | { ok: false; message: string }>;
    /** Sync external source `sourceId` into its collection now. */
    syncSource(sourceId: string, opening: string): Promise<SourceSyncResult>;
    /** The names of the secrets the open project's sources can sign in with, never their values. */
    sourceSecretNames(opening: string): Promise<string[]>;
    /** Keep `value` as the open project's source secret `name`, outside the project, or forget it (null). */
    setSourceSecret(name: string, value: string | null, opening: string): Promise<{ ok: boolean; message?: string }>;
    /** What a web-sized copy of a large library image would be (see WebCopyPlan). */
    webCopyPlan(assetId: string): Promise<WebCopyPlan>;
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
    /** Give saved version `id` a new name; what it holds and when it was saved stay. */
    renameVersion(id: string, name: string, workspaceKey: string): Promise<{ ok: boolean; message?: string }>;
    /** Delete saved version `id`, freeing what only it held. */
    deleteVersion(id: string, workspaceKey: string): Promise<{ ok: boolean; message?: string; freed?: number }>;
    exportSource(format?: ExportFormat): Promise<ExportResult>;
    /**
     * Build the website. `published` is the IDs of the pages the author was shown as published: an export whose
     * snapshot would publish other pages stops instead, so a page shown as a draft is never published unseen.
     */
    exportStatic(format?: ExportFormat, published?: string[]): Promise<ExportResult>;
    /** The project's review editions (#1133), newest first. */
    reviewEditions(): Promise<ReviewEditionManifest[]>;
    /**
     * Build the site for review and picture each page at `routes` at each of `widths` (a desktop and a phone width when
     * none are given), keeping the pictures as a new review edition in the project.
     */
    captureReviewEdition(request: { routes: string[]; widths?: Array<{ label: string; width: number }> }): Promise<ReviewEditionResult>;
    /** Save review edition `editionId` as one HTML file that opens from disk with no Builder, server or network (#1134); the chooser says where. */
    exportReviewSheet(editionId: string): Promise<ReviewSheetResult>;
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
    /**
     * Settle a file conflict. `convert` (a design's own file, `conflicts[].convert`) makes the edited file a code
     * component in the design's place; `expect` is the SHA-256 of the file's bytes as the author compared them, and
     * `opening` the snapshot's `workspaceKey` it was chosen in. `saved`: the sides settling it kept under Saved copies.
     */
    resolveConflict(path: string, choice: ConflictChoice, opts?: { expect?: string; opening?: string }): Promise<{ ok: boolean; message?: string; definitionId?: string; saved?: SavedCopy['side'][] }>;
    /**
     * The versions of a file in conflict, to compare before choosing: SiteOrigin Builder's and the one on disk, and
     * for a conflict an AI request's rollback left (`aiRun`), the version that request tried to save.
     */
    compareConflict(path: string): Promise<{ ok: boolean; builder?: FileText; disk?: FileText; attempted?: FileText; message?: string }>;
    /** What a saved copy (`SavedCopy.id`) holds. */
    readSavedCopy(id: string): Promise<{ ok: boolean; content?: FileText; message?: string }>;
    /** Take a saved copy off the list in Project health. The file itself stays in the project's recovery folder. */
    dismissSavedCopy(id: string): Promise<{ ok: boolean; message?: string }>;
    /** Put a saved copy taken off the list in this opening of the project back on it (Undo). */
    restoreSavedCopy(id: string): Promise<{ ok: boolean; message?: string }>;
    unlock(): Promise<{ ok: boolean; message?: string }>;
    /** `workspaceKey` is the opening of the project the state belongs to (from its snapshot); any other is dropped. */
    saveLocalState(state: LocalWorkspaceState, workspaceKey: string): Promise<void>;
    /**
     * Checks a code component's source as saving it would. With `manifest`, the props the code takes are held to the
     * properties given (the editor's draft), or else those of the component `definitionId` names, and to its axes.
     */
    validateSource(source: string, manifest?: SourceManifest): Promise<{ ok: boolean; errors: string[]; diagnostics: Array<{ message: string; line?: number; column?: number; severity: 'error' | 'warning' }> }>;
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
    /** The context size the saved local server reports for a model, or null. `server`: the saved address asked. */
    localContext(model: string): Promise<{ server: string; reportedWindow: number | null }>;
    conversations(): Promise<{ active: Conversation; list: ConversationSummary[] }>;
    newConversation(): Promise<Conversation>;
    openConversation(id: string): Promise<Conversation>;
    /**
     * Read a conversation of the opening `workspaceKey` without opening it (see ConversationState): main's open thread
     * stays as it is. Refused once that opening has closed.
     */
    readConversation(id: string, workspaceKey: string): Promise<ConversationState>;
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
  /**
   * The open project's pinned notes (#770): short feedback left on a page or an element, kept in the project's local
   * state (never its documents or export) as a checklist. Guests of a live session leave them too; in the remote shell
   * these reach the host's project, as far as the guest's role allows.
   */
  notes: {
    /** The notes as they are now, newest first, in the opening named (its snapshot's workspaceKey); null when that is not the project open. */
    list(opening: string): Promise<LiveNotes | null>;
    /** Leave a note, on the page and element named. */
    add(opening: string, draft: NoteDraft): Promise<LiveNoteResult>;
    /** Mark a note done, or open it again. */
    resolve(opening: string, id: string, resolved: boolean): Promise<LiveNoteResult>;
    delete(opening: string, id: string): Promise<LiveNoteResult>;
  };
  /**
   * Host a live session of the open project. It belongs to that opening: closing the project, switching to another or
   * quitting ends it. Times are on the relay's clock (LiveRoom.relayClockOffsetMs).
   */
  live: {
    /** Open a room on the configured relay for the project opening `opening` (its snapshot's workspaceKey). */
    start(opts: { opening: string; duration: SessionDuration }): Promise<LiveStartResult>;
    /** End the session for everyone. */
    stop(run: LiveRun): Promise<LiveCommandResult>;
    /** Let a waiting guest in, with its own end of access if given (null: until the session ends). */
    admit(run: LiveRun, guestId: string, role: GuestRole, guestExpiresAt?: number | null): Promise<LiveCommandResult>;
    decline(run: LiveRun, guestId: string): Promise<LiveCommandResult>;
    setRole(run: LiveRun, guestId: string, role: GuestRole): Promise<LiveCommandResult>;
    setGuestExpiry(run: LiveRun, guestId: string, guestExpiresAt: number | null): Promise<LiveCommandResult>;
    kick(run: LiveRun, guestId: string): Promise<LiveCommandResult>;
    setLocked(run: LiveRun, locked: boolean): Promise<LiveCommandResult>;
    /** Allow guest notes, or stop guests leaving any more; notes already left stay. */
    setGuestNotes(run: LiveRun, allowed: boolean): Promise<LiveCommandResult>;
    /** Move the session's end later, to `expiresAt` on the relay's clock, at most 24 hours after it started. */
    extend(run: LiveRun, expiresAt: number): Promise<LiveCommandResult>;
    /** Where the host is in the editor (its page and preview width), for guests following it. The latest is kept and resent. */
    presence(run: LiveRun, presence: Presence): Promise<LiveCommandResult>;
    /**
     * Let a collaborator ask this computer's AI to edit (#769), or stop letting it, with a limit on its requests (null:
     * none). Its requests run here, with this computer's provider; turning it off stops the one it has running.
     */
    setAi(run: LiveRun, guestId: string, grant: { allowed: boolean; turnLimit: number | null }): Promise<LiveCommandResult>;
    state(): Promise<LiveHostState>;
  };
  /**
   * This app as a guest in another computer's live session: the remote shell (#766). Joining needs no project open
   * here, and opening one leaves the session. Every call after joining names the join (`RemoteJoin.joinId`), so one
   * meant for a join that has ended reaches no other.
   */
  remote: {
    /** Ask for a place in the session an invite link names; resolves once the relay says where this app stands. */
    join(opts: { inviteLink: string; displayName: string }): Promise<RemoteJoinResult>;
    /** Leave the session; the editor goes back to the Welcome screen. */
    leave(): Promise<void>;
    state(): Promise<RemoteState>;
    /**
     * The host's project as guests are given it: the copy last received, or asked for now (`fresh`: asked again
     * whatever was received). Null when not admitted.
     */
    snapshot(joinId: string, fresh?: boolean): Promise<LiveProjectSnapshot | null>;
    /** Make a collaborator's edit in the host's project, through the host's own pipeline. */
    apply(joinId: string, batch: LiveEditBatch): Promise<LiveApplyResult>;
    /** Where this app is in the editor, for the others: shared while a collaborator. False when it could not be. */
    presence(joinId: string, presence: Presence): Promise<boolean>;
    /** This app's requests to the host's AI in the join named (#769); null when not admitted. */
    ai(joinId: string): Promise<RemoteAi | null>;
    /** Ask the host's AI to edit the page or selection named, when the host allows it. Runs on the host's computer. */
    aiSend(joinId: string, text: string, context: LiveAiContext): Promise<RemoteAiSendResult>;
    /** Stop this app's own request; false when it is no longer running. */
    aiStop(joinId: string, runId: string): Promise<boolean>;
    /** Answer the question this app's request is waiting on; false when it is no longer waiting. */
    aiAnswer(joinId: string, runId: string, questionId: string, answer: string): Promise<boolean>;
    /** The host's pinned notes: the copy last received, or asked for now. Null when not admitted. */
    notes(joinId: string): Promise<LiveNotes | null>;
    /** Leave, resolve or delete a note in the host's project, as far as this guest's role allows. */
    addNote(joinId: string, draft: NoteDraft): Promise<LiveNoteResult>;
    resolveNote(joinId: string, id: string, resolved: boolean): Promise<LiveNoteResult>;
    deleteNote(joinId: string, id: string): Promise<LiveNoteResult>;
  };
  /**
   * The project as it is now. Over IPC (`window.builder`) it comes as a `ProjectChange` from the copy sent before
   * (shared/project-feed.ts); the editor's `api` (lib/transport.ts) hands its listeners the snapshot it makes.
   */
  on(channel: 'project:changed', cb: (snap: ProjectSnapshot) => void): () => void;
  on(channel: 'project:closed', cb: () => void): () => void;
  on(channel: 'create:progress', cb: (p: ProgressEvent) => void): () => void;
  /** A project ZIP file is being unpacked, sent as it starts and as its files are written (null: it finished, failed or was called off). */
  on(channel: 'projects:unpacking', cb: (u: Unpacking | null) => void): () => void;
  on(channel: 'runtime:status', cb: (s: RuntimeState) => void): () => void;
  on(channel: 'preview:load-failed', cb: (failure: { url: string }) => void): () => void;
  on(channel: 'ai:event', cb: (e: AiEvent) => void): () => void;
  /** The editor's Appearance, when Settings saves a new one. */
  on(channel: 'appearance', cb: (appearance: Appearance) => void): () => void;
  /** `targets`: measure only these elements of the page and what is inside them (inspect_layout with refs); `focus`: list only the findings on these elements (validate_project narrowed to them). */
  /** `revision`: the project revision the page is measured at, which the editor shows before it loads the page. */
  on(channel: 'inspect:request', cb: (req: { requestId: string; pageId: string; width: number; revision?: number } & InspectLayoutOptions) => void): () => void;
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
  on(channel: 'input:key', cb: (k: { key: string; code?: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }) => void): () => void;
  /** The host's live session changed: started, a guest joined or left, it dropped or came back, or it ended. */
  on(channel: 'live:state', cb: (state: LiveHostState) => void): () => void;
  /** A guest started waiting to join the live session. */
  on(channel: 'live:request', cb: (request: LiveJoinRequest) => void): () => void;
  /** A collaborator in the live session moved to another page or selection, or left. */
  on(channel: 'live:presence', cb: (presence: LivePresence) => void): () => void;
  /** This app's place in another computer's live session changed: waiting, admitted, a new role, a drop, or an ending. */
  on(channel: 'remote:state', cb: (state: RemoteState) => void): () => void;
  /** The host's project changed, as guests are given it. */
  on(channel: 'remote:changed', cb: (change: { joinId: string; snapshot: LiveProjectSnapshot }) => void): () => void;
  /**
   * The host's preview changed: the canvas loads its page again. `revision` is the project revision a page loaded now
   * shows, as the host last said it (null before it said one).
   */
  on(channel: 'remote:reload', cb: (reload: { joinId: string; revision: number | null }) => void): () => void;
  /** Where the host and the other collaborators are. */
  on(channel: 'remote:presence', cb: (presence: RemotePresence) => void): () => void;
  /** This app's requests to the host's AI changed: access, a request's progress, or its end (#769). */
  on(channel: 'remote:ai', cb: (ai: RemoteAi) => void): () => void;
  /** The host's pinned notes changed, or whether guests may leave them. */
  on(channel: 'remote:notes', cb: (notes: { joinId: string; notes: LiveNotes }) => void): () => void;
  /** The shown project's pinned notes changed, or whether guests may leave them (#770). */
  on(channel: 'notes:changed', cb: (notes: LiveNotes) => void): () => void;
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
