import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs, existsSync, readFileSync, statSync, type BigIntStats, type Dirent, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import type { ComponentDefinition, PageDoc, ProjectBriefDoc, ProjectState, PublishedDoc, SiteDoc } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import { BRIEF_FILE, briefWriteRefusal, type BriefWriteGrant } from '@shared/brief';
import { PUBLISHED_FILE, withPublished } from '@shared/published';
import { collectionGrantRefusal, type CollectionWriteGrant } from '@shared/collection-grant';
import type { SourceWriteGrant } from '@shared/sources';
import { sourceWriteRefusal } from '../sources/grant';
import type { ApplyResult, EditBatch, EditOperation, ToolError, ToolErrorCode } from '@shared/ops';
import type { AiTurnReview, ConflictChoice, FileText, RestoreVersionResult, SavedCopy, SaveFailure, StorageInfo, TurnLaterChange, VersionReview, VersionsInfo } from '@shared/api';
import { validateOperation } from '@shared/ops';
import { axesOf, choicesLost } from '@shared/variants';
import { AXES_FORMAT, formatOf } from '@shared/migrations';
import { applyOperations, assetUsages, captureClipboard, convertEditedDesign, walkOperations, type Clipboard } from '@engine/apply';
import { frozen } from '@engine/draft';
import { clone } from '@engine/install';
import { listThemes, themePinProblem } from '@catalogue/index';
import { anchorsInUse, displayName, EngineError, instancesOf } from '@engine/tree';
import { madeRequiredBy } from '@engine/required';
import { findRemoval, restoreRemoval } from '@engine/restore';
import { pageLinkUses } from '@engine/page-links';
import { foreignSyncedEntry, syncedEntryChange } from '@engine/collections';
import { sourceIntegrityChange, sourceSyncRefusal, syncedDependencyLoss, type SourceSyncGrant } from '@engine/sources';
import { formRoutingChanges, formRoutingRefusal, type FormRoutingGrant, type FormRoutingReview } from '@engine/form-routing';
import { admits, FormRoutingGrants, reviewed } from './form-routing-grants';
import { codeNeeds, declareCodeNames, dependentsOf, filledSlots, removalWithPlacements } from '@engine/definitions';
import { publicationPlan } from '@generator/checks';
import { adviceValidation, blocksSaving, coreValidation, diagnosticKey, introducedDiagnostics, joinValidation, stopsExportOnly, validateState, type CoreValidation, type Diagnostic } from '@engine/validate';
import { withoutKeptSamples } from '@engine/sample-content';
import { developerModeRefusal } from '@engine/developer-mode';
import { findMissingAssetFiles, IMPORTED_DOCUMENT_FILE, IMPORTED_MEDIA_FILE } from './asset-files';
import { keptDraftAssetsNote, restoreDraftAssets } from './draft-assets';
import type { MissingAssetFiles } from '@shared/api';
import type { WriteFailure } from './save-error';
import { EXTERNAL_SOURCE_REFUSED, HISTORY_LIMIT } from '@shared/api';
import { CUSTOM_DIR, defFile, designCalled, GENERATED_DIR, generateManagedComponent, generateProject, GENERATOR_VERSION, packFileCopies, SERVER_HOOK_FILE, webMcpFormFile, type PackFileCopy } from '@generator/index';
import type { ComponentImport } from '@engine/component-package';
import { sendsFormMessages } from '@shared/form-contract';
import { GenerationCache } from '@generator/cache';
import { themeUpdates, type ThemeUpdates } from '@engine/theme-updates';
import { ValidationCache } from '@engine/validation-cache';
import { packFileInfo, readPackFile } from '../packs/files';
import { SITE_ICON_PATHS, SiteIconMaker, siteIconRecord, type IconInput } from './site-icons';
import { ownServerHook } from './server-hook';
import { checkSvelteSource, codeAxisPropProblems, codeContractNames, codeManifestProblems, codePartTexts, componentSources, projectTokenVars } from '../codecheck';
import { isWebMcpForm } from '@shared/webmcp';
import { asRoute, COMPONENT_DOC, componentCycle, linksInto, ownUrlLinks, placementsOf, siteAddresses, siteBases, stepChanges, type DocVersions } from './turn-review';
import { isDiscoveryPath } from '@shared/llms';
import { RSS_PATH } from '@generator/rss';
import { HOST_REDIRECTS_FILE, VERCEL_CONFIG_FILE } from '@generator/host-redirects';
import { atomicWrite, eachAtMost, ensureDir, ensureParents, inBatches, readBytesIfExists, readIfExists, readJson, removeDurable, removeEmptyDirs, safeJoin, safeJoinLooking, sha, stageWrites, syncDir, syncStaged, toJson, FolderPass, WRITES_AT_ONCE, type Looked, type StagedWrite } from './fsutil';
import { designAt, relocateSource, textOfBytes } from './edited-design';
import { collectionDocPath, collectionPathOf, collectionsFromDocs, componentDocPath, converterPathOf, CUSTOM_SOURCE_RE, DOC_DIR, isCanonicalPath, MANIFEST_FILE, newestStoredVersion, ProjectFormatError, readProject, shareUnchanged, sourcePathOf, sourcesFromDocs, stateToAuthoredSources, stateToDocs, type DocReader } from './documents';
import { perf, timed } from '../perf';
import { checkHeld, readFields, sameValue } from '../../renderer/src/lib/held';
import { absent, handleStamp, isMissing, lookAt, OPEN_READ, readFileAt, stampOf, statTrusted } from './stable-read';

export { statTrusted };
import { claimedFiles, heldAsMedia, isVersionMedia, newVersionId, VERSION_DAMAGED, VERSION_NAME_MAX, VersionStore, type PendingOutcome, type SavedVersion } from './versions';
import { gitSaveProblem, keptOutOfGit, versionsGit, writeVersionCommit, type VersionsGit } from './versions-git';
import { captureSnapshotInventory, foldName, GENERATED_MANIFEST, listSnapshotFiles, MAX_SNAPSHOT_FILE } from './snapshot-inventory';
import { GitError, type FileInput } from '../git/protocol';

export const LOCAL_DIR = '.siteorigin';

/** How a project is opened for editing (ProjectSession.open). */
export interface OpenOptions {
  /** Take the lock from the owner with this token (an unlock), or from any owner. */
  force?: boolean | string;
  /** Start the project's preview just before its generated files are published; stopped, and waited for, if it then fails. */
  preview?: { start(s: ProjectSession): void; stop(s: ProjectSession): Promise<void> };
  /**
   * Called once the documents are read and sound and the preview started, just before the open's publication, which
   * waits for the promise it returns: the editor shows the project meanwhile (src/main/controller.ts, openTrusted). The
   * open still resolves after the publication and its sweep. A publication that fails once the project is shown leaves
   * it open with its save unfinished (saveUnfinished), as a reload whose files could not be written does, rather than
   * failing the open. Not called for a project whose format is updated on opening: that update is shown when done.
   */
  shown?: (s: ProjectSession) => Promise<void>;
  /**
   * The open's sweep of history blobs and unused assets runs as the next command after it instead of inside it, so
   * neither the editor's first sight of the project nor its preview waits for it.
   */
  sweepLater?: boolean;
}
/** Sources AI runs wrote or tried to write, a folder per run, in the recovery folder (see keepSourceDraft). */
export const SOURCE_DRAFTS = 'ai-runs';
/** Which property each variant axis of a definition arrives in, comparable between two versions of it. */
const axisPropsKey = (def: ComponentDefinition) => JSON.stringify(axesOf(def).map(([axis, a]) => [axis, a.prop]).sort(([a], [b]) => String(a).localeCompare(String(b))));
/** What a code component's code is held to of its manifest (see codeManifestProblems): its axes' props and its properties. */
const manifestKey = (def: ComponentDefinition) => `${axisPropsKey(def)}|${JSON.stringify(def.properties ?? {})}`;
/** A run's ID as the orchestrator makes it (newId): safe to name a folder with. */
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** In the dev cache: hashes of the generated project files the dev variants stand in for. */
export const CLEAN_HASHES = '.clean-hashes.json';

/** What a generated file that is there but cannot be read hashes to: never ours, never missing. */
const UNREADABLE = 'unreadable';
/** Why a file for AI agents the website no longer has, edited outside the app, is in conflict. */
const OBSOLETE_DISCOVERY_REASON = 'This file for AI agents was edited outside SiteOrigin Builder, and the website no longer has it, so a build would still publish what it says. Restore it to remove it (your version is kept as a copy), or move it out of static/.';
/** A generated file that publishes what the project says, not only where its pages are: one for AI agents, or the RSS feed. */
const publishesWords = (path: string) => isDiscoveryPath(path) || path === RSS_PATH;
const OBSOLETE_FEED_REASON = 'This RSS feed was edited outside SiteOrigin Builder, and the website no longer has one, so a build would still publish what it says. Restore it to remove it (your version is kept as a copy), or move it out of static/.';
/** A generated file of redirect rules a host follows ahead of the website's pages (generator/host-redirects.ts). */
const routesVisitors = (path: string) => path === HOST_REDIRECTS_FILE || path === VERCEL_CONFIG_FILE;
const OBSOLETE_REDIRECTS_REASON = 'These redirect rules were edited outside SiteOrigin Builder, and the website no longer has any, so its host would still follow them, even past a page at one of those addresses. Restore it to remove it (your version is kept as a copy), or rename it.';
/** An obsolete generated file that stays claimed while edited outside the app, since a build would still act on it. */
const claimedWhenObsolete = (path: string) => publishesWords(path) || routesVisitors(path);
const UNREADABLE_REASON = 'Generated file could not be read, so SiteOrigin Builder left it as it is. Check that it is a file you can open, then restore it.';

/**
 * A document's text, read through one handle, with that handle's stat when it did not change while the text was read;
 * null when there is no regular file to read (as readIfExists gives null for anything it cannot read).
 */
async function readTextAt(abs: string): Promise<{ text: string; st: BigIntStats | null } | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(abs, OPEN_READ);
  } catch {
    return null;
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) return null;
    const text = await handle.readFile('utf8');
    const after = await handle.stat({ bigint: true });
    return { text, st: stampOf(after) === stampOf(before) ? before : null };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** How many let-go AI runs History remembers the standing of (see HistoryFile.droppedRuns). */
const DROPPED_RUN_LIMIT = 200;
/** How often an open project refreshes its lock, and how long an unrefreshed lock is still trusted. */
export const LOCK_HEARTBEAT_MS = 30_000;
export const LOCK_STALE_MS = 2 * 60_000;
/**
 * Files written by the asset importer: name-hash8.ext, plus -480w style responsive copies. Documents (PDFs and the
 * like) are left out on purpose: authors placed such files in static/assets/ by hand before the library took them,
 * often with dated names ("rates-20240131.pdf") that look imported, and a sweep must never delete one of those. A
 * removed document's file stays in the folder; exports leave it out.
 */
const IMPORTED_ASSET_RE = IMPORTED_MEDIA_FILE;
/** Documents the importer named: never swept (see above), and never searched for the names of other files. */
const IMPORTED_DOCUMENT_RE = IMPORTED_DOCUMENT_FILE;
/** An imported file is never collected this soon after it was written (its asset may still be on its way in). */
const ASSET_GRACE_MS = 10 * 60_000;
const ASSETS_DOC = `${DOC_DIR}/assets.json`;
/**
 * The eight hash characters an imported file is named by. An original and all its responsive copies share them, and
 * any address built from the file's parts still holds them, so a file counts as named wherever they appear.
 */
const ASSET_TOKEN_RE = /-([a-f0-9]{8})(?:-\d+w)?\.[a-z0-9]+$/;
const assetToken = (name: string) => name.match(ASSET_TOKEN_RE)?.[1] ?? name;
/** How many answers (a stored version or a project file, and a token) the session remembers before starting over. */
const MENTION_CACHE_LIMIT = 200_000;
/** Project files are searched this much at a time, so a file of any size can be searched. */
const SEARCH_CHUNK = 1024 * 1024;
/** Top-level folders that are not the project's own work: tools, caches, history and builds. */
const NOT_SEARCHED = new Set(['node_modules', '.git', LOCAL_DIR, '.svelte-kit', 'build']);
/** Folders never searched wherever they are: installed packages and version control. */
const NEVER_SEARCHED = new Set(['node_modules', '.git']);
/** Top-level folders searched even through a link, as the project's documents, source and public files. */
const OWN_FOLDERS = new Set([DOC_DIR, 'src', 'static']);

/** The files in static/assets/, with what still needs each (see assetInventory). */
interface AssetInventory {
  /** The static/assets/ folder. */
  dir: string;
  /** Regular files directly in it. */
  files: AssetFile[];
  /** Tokens (see assetToken) of imported files that recovery material (an active run, a held conflict) names. */
  pinned: Set<string>;
  /** For each history entry, the tokens of imported files its versions name. */
  byEntry: Array<Set<string>>;
  /** A file the project uses now: one the library lists, or one something in the project names. */
  inUse(f: AssetFile): boolean;
  /** An imported file nothing names: the project, recovery material and history all do without it. */
  unneeded(f: AssetFile): boolean;
}
interface AssetFile {
  name: string;
  bytes: number;
  mtimeMs: number;
  ino: number;
  token: string;
}

/** Does `text` name `file` as a whole file name, so that `a-logo.svg` is not found inside `ba-logo.svg`? */
function namesFile(text: string, file: string): boolean {
  for (let i = text.indexOf(file); i >= 0; i = text.indexOf(file, i + 1)) if (i === 0 || !/[\w.-]/.test(text[i - 1])) return true;
  return false;
}

/** A restore stopped before its documents were saved: the files it put back are put back as they were. */
class RestoreStopped extends Error {}

/** A version could not be saved to Git because the project's version history is damaged. */
class HistoryDamaged extends Error {}

/** Whether a part of project path `rel` that is there is a link: looked at from the top down; a part not there ends it. */
async function linkOnTheWay(root: string, rel: string): Promise<boolean> {
  let at = root;
  for (const part of rel.split('/')) {
    const st = await fs.lstat((at = join(at, part))).catch(() => null);
    if (!st) return false;
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

/** The version the app saves of a project that has never had one (#1156). */
export const STARTING_VERSION = 'Starting version';
/** The version the app saves of the site before its theme is switched (#1156). */
export const BEFORE_THEME = 'Before changing theme';

/**
 * A version an export captured, listed once the export is delivered: what collection must keep until `release`, and
 * with Git snapshots on, every file of the site its commit holds from disk, by SHA-256.
 */
export interface ExportedVersion {
  version: SavedVersion;
  release: () => void;
  files: Map<string, string>;
}

/** How a version is captured (captureVersion). */
interface CaptureOptions {
  /** Saved by the app by itself. */
  auto?: boolean;
  /** The version of the site as a restore left it (#1155), by the ID its restore noted first. */
  restored?: { id: string };
  /** Files a restore is about to put something else in, held as they are now. */
  also?: string[];
  /** Files a restore put where none were, by what it put there. */
  filled?: Record<string, string>;
  /** Saved in the plain store whatever the Git snapshots setting says. */
  plain?: boolean;
  /** Asked between files: true stops the capture (CaptureStopped), with nothing listed. */
  stop?: () => boolean;
  /** Filled, with Git snapshots on, with every file of the site the commit holds from disk, by its SHA-256. */
  hashes?: Map<string, string>;
  /** Stops the Git write part way (as `stop` does between files). */
  signal?: AbortSignal;
}

/** A capture stopped by its `stop` (the project is closing). */
class CaptureStopped extends Error {
  constructor() {
    super('The version was not saved: the project is closing.');
  }
}
const stopIf = (stop?: () => boolean) => {
  if (stop?.()) throw new CaptureStopped();
};

/** A version's name as another's names it, kept short however often restores nest. */
const shortName = (name: string) => (name.length > 50 ? `${name.slice(0, 49).trimEnd()}…` : name);

/** The name of the version saved before restoring the one named `name`. */
function backupName(name: string): string {
  return `Before restoring “${shortName(name)}”`;
}

/** The name of the version of the site as restoring the one named `name` left it (#1155). */
function restoredName(name: string): string {
  return `Restored “${shortName(name)}”`;
}

/** Every stored version a history entry restores or expects. */
const entryBlobs = (e: HistoryEntry) => Object.values(e.docs).flatMap((d) => [d.before, d.after]).filter((x): x is string => !!x);

/**
 * History with a change folded into it rather than recorded as a step (a library image's copies arriving after the
 * import that added it, #979): for each document the change rewrote, the nearest applied step that left it and the
 * nearest undone step that expects it name the new version instead of the one replaced, when they named that one. Those
 * are the versions Undo and Redo check the document against first, so both still find it as they left it, and each
 * then restores what it always did (an Undo of the import, the images without their copies). Steps further away, and
 * the order and number of steps, are as they were.
 */
function amendedHistory(h: HistoryFile, changed: Record<string, { before: string | null; after: string | null }>): HistoryFile {
  const entries = h.entries.map((e) => ({ ...e, docs: { ...e.docs } }));
  for (const [path, { before, after }] of Object.entries(changed)) {
    if (!before || !after) continue;
    for (let i = h.cursor - 1; i >= 0; i--) {
      const d = entries[i].docs[path];
      if (!d) continue;
      if (d.after === before) entries[i].docs[path] = { ...d, after };
      break;
    }
    for (let i = h.cursor; i < entries.length; i++) {
      const d = entries[i].docs[path];
      if (!d) continue;
      if (d.before === before) entries[i].docs[path] = { ...d, before: after };
      break;
    }
  }
  return { ...h, entries };
}

/** Whether `copy` is a file of the responsive copies of the library file `file`, as the importer names them. */
const copyOf = (file: string, copy: string) => copy.startsWith(`${file.replace(/\.[a-z0-9]+$/, '')}-`) && /^static\/assets\/[a-z0-9][a-z0-9-]*-\d+w\.(jpg|png|webp|avif)$/.test(copy);

/** The project files (static/assets/…) an assets document lists, with their responsive copies. */
function libraryFiles(text: string | null | undefined): string[] {
  if (!text) return [];
  try {
    const doc = JSON.parse(text) as ProjectState['assets'];
    return Object.values(doc.assets ?? {}).flatMap((a) => [a?.file, ...(a?.variants ?? []).map((v) => v?.file)]).filter((f): f is string => typeof f === 'string');
  } catch {
    return [];
  }
}

/** The asset document without its original names: those name files on the author's computer, never project files. */
function withoutOriginalNames(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), (key, value) => (key === 'originalName' ? undefined : value));
  } catch {
    return text;
  }
}

/** Which of `tokens` the file at `abs` holds, read a piece at a time with an overlap, so nothing split is missed. */
async function searchFile(abs: string, tokens: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  const overlap = Math.max(1, ...tokens.map((t) => t.length)) - 1;
  const buf = Buffer.alloc(SEARCH_CHUNK + overlap);
  const handle = await fs.open(abs, 'r');
  try {
    let carry = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buf, carry, SEARCH_CHUNK, null);
      if (!bytesRead) break;
      const view = buf.subarray(0, carry + bytesRead);
      for (const t of tokens) if (!found.has(t) && view.includes(t, 0, 'latin1')) found.add(t);
      if (found.size === tokens.length) break;
      carry = Math.min(overlap, view.length);
      view.copy(buf, 0, view.length - carry);
    }
  } finally {
    await handle.close();
  }
  return found;
}
const UNSETTLED = 'An earlier save did not finish, so nothing more is saved until the project is closed and reopened.';
/** A change stopped part way by a file saved outside the app: this change, not an earlier one, waits on reopening. */
const STOPPED_PART_WAY = 'A file was changed outside SiteOrigin Builder while this change was being saved, so the save did not finish. Close and reopen the project to finish it: Project health then shows the file in conflict.';
/** The same, stopped before anything of it was written, with its journal gone but its folder not confirmed: reopening finishes nothing of it. */
const STOPPED_UNSAVED = 'A file was changed outside SiteOrigin Builder while this change was being saved, so it was not saved, and nothing more is saved until the project is closed and reopened.';
const LOCK_UNCHECKED = 'The project lock could not be checked, so nothing was changed. Try again.';
/** Why a project whose folder went while it was open is read-only. */
const FOLDER_GONE: ReadOnlyInfo = {
  reason: 'The project folder is gone: it was moved, renamed or deleted, so it is read-only here. Close the project, then open it from where it is now.',
  preview: 'There is no preview: the project folder is gone.',
  canUnlock: false
};

/** The project is open in another live SiteOrigin Builder (on this or another computer). */
export class ProjectLockedError extends ProjectFormatError {
  constructor(message: string, public readonly owner: LockOwner) {
    super(message);
  }
}

export interface LockOwner {
  host: string;
  since?: string;
  /** Identifies this acquisition of the lock, so an unlock takes over exactly the owner that was shown. */
  token?: string;
}

/** Why a project is open read-only. */
/** The project's theme pack is not available here, so it opens read-only (see themePinProblem). */
export class ThemeUnavailableError extends ProjectFormatError {
  constructor(message: string) {
    super(message, true);
  }
}

export interface ReadOnlyInfo {
  reason: string;
  /** Why there is no preview, when it is not that a newer app made the project. */
  preview?: string;
  /** The lock may belong to a crashed or unreachable app; the user can take it over. */
  canUnlock: boolean;
  /** The owner the user is shown: unlocking takes over this owner only. */
  lockToken?: string;
}

export interface HistoryEntry {
  id: string;
  label: string;
  source: 'user' | 'ai' | 'system';
  time: string;
  revision: number;
  /** Document path -> blob hash before and after (null = absent). */
  docs: Record<string, { before: string | null; after: string | null }>;
  coalesceKey?: string;
  runId?: string;
  /**
   * The AI run whose change this entry took back on its own, keeping the edits made after it (issue 164): while this
   * entry is applied, that run's turn reads as undone. Never on the AI run's own entry, which `runId` names.
   */
  revertsRunId?: string;
  /** The live-session guest who made this change, by the name the host let them in under (#765); on an AI step, the guest the AI ran for (#769). */
  guestName?: string;
  /**
   * A saved version's restore (#1474). It may rewrite a synced collection's entries, as no edit may, so taking it back
   * or putting it back again may too: Undo returns what the last sync wrote, Redo the version's own.
   */
  restore?: true;
}

interface HistoryFile {
  /** The document format of the versions these entries restore. Absent in the first format. */
  schemaVersion?: number;
  entries: HistoryEntry[];
  /** Number of entries currently applied (entries beyond this are redoable). */
  cursor: number;
  /**
   * AI runs whose step History has let go, and whether that step was applied or undone when it went, so the chat
   * turn that made it still shows where its change stands (issue 276). Oldest first, at most DROPPED_RUN_LIMIT.
   */
  droppedRuns?: Record<string, DroppedRun>;
}

/** Where an AI run's step stood when History let it go: still in the site, or undone. */
type DroppedRun = 'applied' | 'undone';

/** The AI run holding the project (ProjectSession.activeRun): its checkpoint, and what it has written. */
interface ActiveRunInfo {
  id: string;
  before: Map<string, string>;
  beforeState: ProjectState;
  startRevision: number;
  written: Map<string, Set<string | null>>;
  hashes: Map<string, { text: string; hash: string }>;
}

/**
 * `sessions/active-run.json`: what an AI run has changed, file by file, so a crash restores its checkpoint. `before` and
 * `after` name stored versions; `written` every version the run has put in the file.
 */
interface RunMarker {
  id: string;
  paths: Record<string, { before: string | null; after: string | null; written: Array<string | null> }>;
}

/**
 * The publication journal: everything one change does, written durably before any of it is. Recovery rolls it
 * forward, so a crash leaves the whole change or none of it. Besides the documents it carries the history the change
 * leaves (so the undo position moves with the documents) and, for a finishing AI run, the run it finishes.
 */
interface Journal {
  schemaVersion: number;
  writes: Array<{ path: string; blob: string; before: string | null }>;
  deletes: Array<{ path: string; before: string }>;
  /** The history file after this change. Absent when the change leaves history as it is. */
  history?: HistoryFile;
  /** The project revision after this change. */
  revision?: number;
  /** The AI run this change completes: its marker goes once the change is done. */
  finishRun?: string;
  /**
   * The marker of the AI run this change was saved into the checkpoint of (an edit saved while the run waits for an
   * answer, #1281): it replaces the run's marker once the change is done, so stopping the run, or a crash, restores a
   * checkpoint that holds the change.
   */
  runMarker?: RunMarker;
  /**
   * The versions (by hash) the change's writes and History name that were not stored when it was journaled: they are
   * stored after its documents, and from here by a recovery that comes first.
   */
  versions?: Record<string, string>;
}

/** The most new versions, and the most bytes of them, a save's journal carries; a save with more stores them before it. */
const CARRIED_VERSIONS = 64;
const CARRIED_BYTES = 4 * 1024 * 1024;

interface GeneratedManifest {
  generator: string;
  files: Record<string, string>;
  /** Files a publication was writing when it stopped: each is this app's own if it holds that version. */
  pending?: Record<string, string>;
}

/** Whether an operation changes a collection or one of its entries. */
/** Whether a value names a collection's layout template (or archive layout) as an owner, at most a few levels in (`target.owner`). */
const namesTemplate = (v: unknown, depth = 0): boolean =>
  !!v && typeof v === 'object' && depth < 4 && ((v as { kind?: unknown }).kind === 'template' || (v as { kind?: unknown }).kind === 'archive' || Object.values(v as Record<string, unknown>).some((x) => namesTemplate(x, depth + 1)));
/** Why an edit saved while the AI waits (#1281) waits for the request to end after all, said first. */
const EARLY_SAVE_WAITS = 'Your edit can be saved once the AI request ends.';

/**
 * Why the author's held edit (`ops`, made where each field it writes held `base`) cannot be saved while the AI waits
 * for their answer, or null when it can: every field must hold what they saw both in the project (`state`) and in the
 * checkpoint stopping the request restores (`start`). `details.held` says which: changed, gone, or differs.
 */
function heldRefusal(state: ProjectState, start: ProjectState, ops: EditOperation[], base: unknown[]): ToolError | null {
  if (!Array.isArray(base) || base.length !== ops.length || !readFields(state, ops))
    return { code: 'INVALID_ARGUMENT', message: 'Only a typed edit can be saved while the AI waits for your answer.', recoverable: false };
  const now = checkHeld(state, ops, base);
  if (now.kind === 'gone') return { code: 'CONFLICT', message: `The ${now.what} this edit was for no longer exists.`, recoverable: true, details: { held: 'gone' } };
  if (now.kind === 'changed') return { code: 'CONFLICT', message: 'This changed while you were typing.', recoverable: true, details: { held: 'changed' } };
  const there = checkHeld(start, ops, base);
  if (there.kind === 'gone') return { code: 'CONFLICT', message: `${EARLY_SAVE_WAITS} The AI made the ${there.what} it is for in this request.`, recoverable: true, details: { held: 'differs' } };
  if (there.kind === 'changed') return { code: 'CONFLICT', message: `${EARLY_SAVE_WAITS} The AI changed this in this request.`, recoverable: true, details: { held: 'differs' } };
  return null;
}

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The step of a stateDelta path that names the order of a list's items: no item's ID makes it (those are `#{id}`). */
const ORDER_STEP = '\u0001order';

/** The items of a list each with an ID of their own, by ID, or null for any other list. */
function itemsById(list: unknown[]): Map<string, unknown> | null {
  const out = new Map<string, unknown>();
  for (const item of list) {
    const id = plainObject(item) ? item.id : undefined;
    if (typeof id !== 'string' || out.has(id)) return null;
    out.set(id, item);
  }
  return out;
}

/**
 * Every value that differs between two states, by its path through them, with its value in each. Parts the two share
 * are skipped unread (an edit copies only what it changes). A list whose items have IDs is compared item by item by ID,
 * with their order as a value of its own (ORDER_STEP), so an edit of one item is told apart from a change to another, or a move;
 * any other two lists of the same length item by item; lists of different lengths are one value. A path is missing on
 * one side when its value is undefined there, so an object made on the way to a field is never told apart from the
 * field itself.
 */
function stateDelta(a: unknown, b: unknown, at = '', out = new Map<string, [unknown, unknown]>()): Map<string, [unknown, unknown]> {
  if (a === b) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    const x = itemsById(a);
    const y = itemsById(b);
    if (x && y) {
      for (const id of new Set([...x.keys(), ...y.keys()])) stateDelta(x.get(id), y.get(id), `${at}\u0000#${id}`, out);
      const order = (m: Map<string, unknown>) => [...m.keys()];
      if (!sameValue(order(x), order(y))) out.set(`${at}\u0000${ORDER_STEP}`, [order(x), order(y)]);
      return out;
    }
    if (a.length === b.length) {
      a.forEach((v, i) => stateDelta(v, b[i], `${at}\u0000${i}`, out));
      return out;
    }
  }
  if ((plainObject(a) || a === undefined) && (plainObject(b) || b === undefined) && (plainObject(a) || plainObject(b))) {
    const x: Record<string, unknown> = plainObject(a) ? a : {};
    const y: Record<string, unknown> = plainObject(b) ? b : {};
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) stateDelta(Object.hasOwn(x, k) ? x[k] : undefined, Object.hasOwn(y, k) ? y[k] : undefined, `${at}\u0000${k}`, out);
    return out;
  }
  if (!sameValue(a, b)) out.set(at, [a, b]);
  return out;
}

/** The value at a path stateDelta names, or undefined where there is none. */
function valueAt(root: unknown, at: string): unknown {
  let v = root;
  for (const step of at.split('\u0000').slice(1)) {
    if (Array.isArray(v)) {
      if (step === ORDER_STEP) return itemsById(v) ? [...itemsById(v)!.keys()] : undefined;
      v = step.startsWith('#') ? itemsById(v)?.get(step.slice(1)) : v[Number(step)];
    } else v = plainObject(v) && Object.hasOwn(v, step) ? v[step] : undefined;
    if (v === undefined) return undefined;
  }
  return v;
}

/** An edit of a collection, of its entries, or of its layout template. */
const isCollectionOperation = (o: EditOperation) => o.type.startsWith('collection.') || o.type.startsWith('entry.') || namesTemplate(o);

/**
 * A change checked against files it does not write: a collection removal guards the links other entries and pages
 * hold, a new address must be free of every page's and entry's, and a component rebuild must suit every placement. One
 * changed outside the app since it was read makes that check stale, so the change waits for it (see `wholeProject`).
 */
function readsWholeProject(o: EditOperation, state: ProjectState): boolean {
  switch (o.type) {
    // A page's new address must be free of every entry's too, once the project has any.
    case 'page.create':
    case 'page.duplicate':
    case 'page.setHome':
      return Object.keys(state.collections).length > 0;
    case 'page.update':
      return o.route !== undefined && Object.keys(state.collections).length > 0;
    case 'collection.create':
    case 'collection.remove':
    case 'entry.create':
    case 'entry.remove':
      return true;
    // A source's settings are checked against every collection and source, which one added outside the app changes.
    case 'source.upsert':
    case 'source.remove':
      return true;
    // A redirect's old address must be free of every page's and entry's, and where it goes must be there.
    case 'redirect.add':
    case 'redirect.update':
      return true;
    // A term's change rewrites, or is refused by, the lists of entries anywhere that choose it.
    case 'collection.createTerm':
    case 'collection.renameTerm':
    case 'collection.removeTerm':
      return true;
    // So is turning pages on (their addresses), entry text off (every entry's text), or a field that names entries of
    // another collection.
    case 'collection.update':
      return o.route !== undefined || o.pages !== undefined || o.hasBody !== undefined || o.fields !== undefined;
    // A rebuild is checked against every placement of the component, in files it may leave as they are.
    case 'component.upsert':
      return o.definitionId !== undefined;
    // So is what a wrap, an ungroup or a removal that keeps content moves: it must still nest where it renders, in designs
    // and placements in other files.
    case 'node.wrap':
    case 'node.unwrap':
    case 'node.removeKeepContent':
      return true;
    // So is a swap: it is planned against the old and new designs (and, inside a design, every placement of it), which
    // live in files it may leave as they are.
    case 'instance.swapComponent':
      return true;
    // A component's removal, or a slot's, is refused while any placement holds it or holds content there: a placement
    // added in another file it does not write would be left naming what has gone.
    case 'component.remove':
    case 'component.removeSlot':
    // So is a container turned into a slot: what it held moves into placements in other files, and must nest there.
    case 'component.containerToSlot':
      return true;
    // A reference names entries of another collection, in their own files.
    case 'entry.update':
      return o.slug !== undefined || (o.values !== undefined && Object.keys(o.values).some((k) => state.collections[o.collectionId]?.settings.fields?.[k]?.type === 'reference'));
    default:
      return false;
  }
}


/** A page's document path, capturing the page ID. */
const PAGE_DOC = new RegExp(`^${DOC_DIR}/pages/([^/]+)\\.json$`);
const SITE_DOC = `${DOC_DIR}/site.json`;

/** How many recent copies a session keeps for Paste. */
const CLIPBOARD_LIMIT = 5;

export interface CommitOptions {
  label: string;
  source?: 'user' | 'ai' | 'system';
  /** Merge into the previous history entry when keys match and it was recent. */
  coalesceKey?: string;
  /** Skip history (used for provisional AI batches and undo/redo themselves). */
  history?: boolean;
  /** The AI run this change takes back on its own (see HistoryEntry.revertsRunId). */
  revertsRunId?: string;
  /** The live-session guest the change is from (see HistoryEntry.guestName). */
  guestName?: string;
  /**
   * A live-session guest's grant (#765), asked with the project as the change would leave it, as the last thing before
   * anything is written: a refusal then leaves the project, its files and History as they were, with no failed save.
   */
  guard?: (next: ProjectState | null) => ToolError | null;
}

/** How a change is saved (ProjectSession.persist). */
type PersistOptions = CommitOptions & {
  runId?: string;
  cursor?: number;
  wholeProject?: boolean;
  amendHistory?: boolean;
  /** The change is a saved version's restore (see HistoryEntry.restore). */
  restore?: boolean;
  /**
   * The active run's checkpoint with this change made to it too (#1281): an author's edit saved while the run waits for
   * an answer. Its History step goes from the checkpoint to this, and the run's checkpoint becomes this in the same
   * journaled step, so stopping the run, or a crash, keeps the edit, and the run's own step never holds it.
   */
  rebaseRun?: ProjectState;
  /**
   * Files the change removes that are already gone from disk, as the project knows (a code component's file deleted
   * outside the app, #1540): their absence is what the change expects there. A file back at one of them is still kept.
   */
  absent?: ReadonlySet<string>;
};

/** A change its guard refused at the last moment (CommitOptions.guard): nothing of it was written. */
class GuardRefusal extends Error {
  constructor(readonly refusal: ToolError) {
    super(refusal.message);
  }
}

export interface SessionEvent {
  revision: number;
  changedDocs: string[];
  changedFiles: string[];
  label: string;
  source: 'user' | 'ai' | 'system';
  /** The history entry the change was recorded in (absent when history was skipped or nothing changed). */
  entryId?: string;
}

/** A canonical file changed on disk since the app last read or wrote it. */
const MANIFEST = 'siteorigin.project.json';

export class DiskConflictError extends Error {
  constructor(public path: string) {
    super(`${path} was changed outside SiteOrigin Builder. Your edit was not saved so the external change is kept.`);
  }
}

/** Validation codes that make a project unsafe to generate from. */
const FATAL_CODES = new Set(['HOME_MISSING', 'PAGE_MISSING', 'PAGE_ORPHAN', 'ROUTE_INVALID', 'ROUTE_DUPLICATE', 'HOME_ROUTE', 'REDIRECT_INVALID', 'REDIRECT_TARGET', 'NODE_MISSING', 'NODE_SHARED', 'DEF_MISSING']);

export interface Conflict {
  path: string;
  reason: string;
  /** canonical: a project document changed outside the app; generated: a derived source file was edited. */
  kind: 'canonical' | 'generated';
  /** SiteOrigin Builder's version has no such file: using it removes the file. */
  builderMissing?: boolean;
  /**
   * Left by an AI request rolled back around an external edit: SiteOrigin Builder's version is the one from before the
   * request, and the version the request tried to save is kept beside it for inspection.
   */
  aiRun?: boolean;
  /**
   * A design's own file, written by the app and edited outside it, whose text can become a project code component in
   * the design's place (#737): the design it is the file of.
   */
  convert?: { definitionId: string };
  /**
   * A project code component's file deleted outside the app while the project was open (#1540): SiteOrigin Builder's
   * version is the code it last loaded, which the component keeps meanwhile; the file can be put back from it, or the
   * component removed with its placements.
   */
  deletedCode?: { definitionId: string };
}

/** Why a code component's file is held after it was deleted outside the app (#1540). */
const DELETED_CODE_REASON = 'Deleted outside SiteOrigin Builder.';

/** A project code component with no file (#1540), as Project health and the export say it. */
export function missingCodeMessage(name: string, path: string): string {
  return `The code component “${name}” has no file at ${path}: it was moved or deleted outside SiteOrigin Builder. Put the file back, or remove the component and its placements.`;
}

/** How a design's edited file is converted: `expect` is the hash of the bytes the author compared, when they did. */
export interface ConvertOptions {
  expect?: string;
  /** Developer mode, as every way of making code asks it: false refuses. */
  codeAllowed?: boolean;
}

/** Said when the file in conflict is no longer the version the author compared and chose against. */
const CHANGED_SINCE_COMPARED = 'The file changed since you compared the versions. Look again, then choose.';

/**
 * One open, writable project. Owns canonical state, the revision counter, history,
 * the publication journal and generated output. All writes pass through `apply` or `commitState`.
 */
/**
 * Why designs a package brought (or a batch built whole) don't compile as the app generates them (`files`), for the
 * server and the browser, or null when they all do. `what` says what can't happen, such as "can't be imported".
 */
async function compileDesigns(defs: ComponentDefinition[], files: Map<string, string>, what = "can't be imported"): Promise<string | null> {
  if (!defs.length) return null;
  const { compile } = await import('svelte/compiler');
  for (const def of defs) {
    const source = files.get(defFile(def));
    if (source === undefined) return `“${def.name}” ${what}: its design could not be generated.`;
    for (const generate of ['client', 'server'] as const) {
      try {
        compile(source, { filename: defFile(def), generate, runes: true });
      } catch (e) {
        return `“${def.name}” ${what}: its design doesn't compile (${(e as Error).message.split('\n')[0]}).`;
      }
    }
  }
  return null;
}

/** A code component's file edited outside the app and not loaded: where, and what the editor is told (#1533). */
interface RefusedSource {
  path: string;
  message: string;
  /** Its code is fine, but waits on the rest of the read, which was refused. */
  held?: true;
}

/** A code component's source as a read found it changed: where, and the refusal if it has errors. */
interface EditedSource {
  id: string;
  name: string;
  path: string;
  problem: boolean;
  message: string;
}

export class ProjectSession extends EventEmitter {
  private current!: ProjectState;
  /**
   * The project as it stands, frozen through and through: a change is a new state, which shares the documents it did
   * not change with the one before (src/engine/draft.ts), so no one holding a state can change another, and a
   * document's text is kept while it is the same object (documents.ts). Only `starting` holds one open, until
   * `writeNew`.
   */
  get state(): ProjectState {
    return this.current;
  }
  set state(next: ProjectState) {
    this.current = frozen(next);
  }
  revision = 0;
  private docs = new Map<string, string>();
  private history: HistoryFile = emptyHistory();
  private generated: GeneratedManifest = { generator: GENERATOR_VERSION, files: {} };
  /** The files the app writes for each state an import check has asked about (writtenFiles). */
  private written = new WeakMap<ProjectState, Set<string> | null>();
  /**
   * The generated manifest as opening read it, with the stat of its file when that can stand for its text
   * (statTrusted); null once anything has written it since. A publication that would write it unchanged leaves it.
   */
  private manifestRead: { text: string; stamp: string } | null = null;
  /** Generated files kept between generations, each given back while what it was made from is unchanged. */
  private generation = Object.assign(new GenerationCache(), { timing: perf.on });
  /**
   * Generated files as last read from disk, by absolute path: the file's stat then and the hash of its bytes. A file
   * whose stat has not changed since is not read again.
   */
  private seenOnDisk = new Map<string, { stamp: string; hash: string }>();
  /** Generated files whose variant changed alone but which could not be touched for the preview: tried again. */
  private untouched = new Set<string>();
  /** The hash of each generated file's latest content, by absolute path, so unchanged content is not hashed again. */
  private contentHashes = new Map<string, { content: string | Buffer; hash: string }>();
  /**
   * Set by whatever runs the preview. Asked before the first file of a publication the preview watches is replaced,
   * it resolves once the preview holds its hot updates, with the call that hands it the files the publication changed,
   * so the page takes them as one update.
   */
  previewHold: (() => Promise<(files: string[]) => void>) | null = null;
  /** The files the publication under way has changed on disk, project-relative, while the preview holds for it. */
  private landing: Set<string> | null = null;
  /**
   * The website's PNG icons, made from the favicon or the monogram, kept while nothing they are made from changes. A
   * set a save stopped waiting for is published on its own once it is ready, while this app holds the project's lock
   * (a new project's session has none until the app takes it; the set is then published as the project opens).
   */
  private siteIcons = new SiteIconMaker(
    () => {
      if (this.lockState === 'held') void this.refreshSiteIcons().catch(() => null);
    },
    () => this.settleMs
  );
  /** The icons the last finished publication carried (what they were made from, and which drawing made them). */
  private iconsPublished: { key: string; id: number | null } | null = null;
  /** What the icons the last publication asked for are made from. */
  private iconsAsked: string | null = null;
  /** Whether this session has looked for the last publication's record of its icons (once, as it opens). */
  private iconsRecalled = false;
  /** The record of the icons as this session last read or wrote it, so an unchanged one is not written again. */
  private iconsRecord: string | null = null;
  /**
   * How long a file must have been left alone before its stat alone is trusted to show a later change: well past the
   * coarsest timestamps (two seconds on FAT), so a change in the same tick as the last one is never missed.
   */
  settleMs = 3000;
  /** Checks worked out from a state, kept for as long as it is the session's: the state is replaced, never changed. */
  private derived = new WeakMap<ProjectState, { core?: CoreValidation; diagnostics?: Diagnostic[]; saving?: Diagnostic[]; usages?: Record<string, number>; updates?: ThemeUpdates }>();
  /** The parts of validation one state can share with the next: each document checked again only when it changes. */
  private validation = new ValidationCache();
  conflicts: Conflict[] = [];
  /** While the open's publication runs after the project is shown: the conflicts as they were before it (shownConflicts). */
  private conflictsBeforeOpen: Conflict[] | null = null;
  /**
   * The conflicts the editor is shown: while the open's publication checks the generated files, the list from before
   * it, never a list it is part way through; its own once it is done.
   */
  get shownConflicts(): Conflict[] {
    return this.conflictsBeforeOpen ?? this.conflicts;
  }
  /**
   * For each canonical document in conflict, the version SiteOrigin Builder holds (null = the document should not
   * exist). The in-memory state uses these versions; the external version stays on disk until the user chooses.
   */
  private pending = new Map<string, string | null>();
  /**
   * Code components whose file was edited outside the app into code with errors, by definition id: the file, and the
   * refusal as the editor shows it. The project keeps the version that last loaded; the file keeps the edit. Worked out
   * again by every read that gets as far as the code (#1533), and held only in memory.
   */
  private refusedSources = new Map<string, RefusedSource>();
  /**
   * Project code components' files that were not there when the project was last read, and that the app has not
   * written since (#1540): their components read as empty code, and are named as missing their file.
   */
  private absentSources = new Set<string>();
  /**
   * For each canonical document in conflict that an AI request's rollback left, the version that request tried to save:
   * the stored blob that holds it (null = it removed the file), and its text once read. The reference is kept even
   * while the text cannot be read, so it is never forgotten or collected. Shown when comparing, and kept under Saved
   * copies once the conflict is settled; never offered as a choice. A conflict marked `aiRun` without one here had no
   * usable reference.
   */
  private attempts = new Map<string, Attempt>();
  /** Holds read back from conflicts.json when the project opened. */
  private loadedHolds = new Set<string>();
  recoveryNotes: string[] = [];
  /** Copies of the versions the author chose against when settling conflicts, newest first (see SavedCopy). */
  savedCopies: SavedCopy[] = [];
  /** Saved copies taken off the list in this opening of the project, by ID, so Undo can put one back as it was. */
  private dismissedCopies = new Map<string, SavedCopy>();
  /** Set when the project is open for inspection only: nothing is ever written. */
  readOnly: ReadOnlyInfo | null = null;
  /** History retention: the oldest groups are pruned past this many bytes of history blobs (spec 18.4). */
  historyByteLimit = 512 * 1024 * 1024;
  private gcCountdown = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  private folderGone = false;
  /** Run currently holding the writer lock. */
  /** `hashes`: the SHA-256 of each document's text as the run's markers last hashed it, by path. */
  activeRun: ActiveRunInfo | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  private idempotency = new Map<string, { fingerprint: string; result: ApplyResult }>();
  /** What the user allowed of AI batches that change where a contact form sends, and what they may yet be asked (#1129). */
  private routingGrants = new FormRoutingGrants();
  /** The documents were read in an older format and the update has not been stored yet. */
  private migrationDue = false;
  /** Publishing an update failed and may have left its journal, which only reopening the project can finish. */
  private migrationFailed = false;
  /** What the editor copied most recently, newest last. Held only while this project is open; never saved. A
   *  few are kept so a paste pressed before a later copy finished still finds the copy it followed. */
  private clipboards: Clipboard[] = [];
  /** A save failed after its journal was written: only reopening the project can finish it, so nothing else is written. */
  private settledLost = false;
  private get unsettled(): boolean {
    return this.settledLost;
  }
  private set unsettled(on: boolean) {
    const news = on && !this.settledLost;
    this.settledLost = on;
    // The editor shows it at once, whatever the command that found it goes on to do.
    if (news) this.emit('save-failed');
  }
  /** The last save that failed with nothing of it written, until a later save succeeds. */
  private failedSave: { label: string; message: string } | null = null;
  /** What became of each save that failed, by the error it threw: told apart as it failed, so a later one never says
   *  another's fate (see writeFailure). */
  private writeFailures = new WeakMap<object, WriteFailure>();
  /** The save being written put its own journal in place (its rename succeeded): only that journal is one reopening
   *  finishes for it, never a file that was there already. */
  private journalInPlace = false;
  /** Named versions of the site, kept apart from history until the author deletes them (issue 260). */
  private versions: VersionStore;

  constructor(public readonly dir: string) {
    super();
    this.versions = new VersionStore(this.local('versions'), dir);
  }

  local(...parts: string[]): string {
    return join(this.dir, LOCAL_DIR, ...parts);
  }

  // -------------------------------------------------------------------------
  // Open / create
  // -------------------------------------------------------------------------

  static create(dir: string, state: ProjectState): Promise<ProjectSession> {
    return ProjectSession.starting(dir, state).writeNew();
  }

  /**
   * The session of a project being made in `dir`, none of its files written yet (`writeNew` writes them): its website's
   * icons start drawing at once, so the first publication finds them drawn while the caller puts the project's other
   * files in place. The caller may still add to `state` (the sample photos' records) until then.
   */
  static starting(dir: string, state: ProjectState): ProjectSession {
    const s = new ProjectSession(dir);
    s.current = state;
    void s.siteIcons.prepare(dir, state).catch(() => undefined);
    return s;
  }

  /** Write a project made by `starting`: its documents, its first publication and its local state. */
  writeNew(): Promise<ProjectSession> {
    return timed('session.create', () => this.writeNewTimed())();
  }

  private async writeNewTimed(): Promise<ProjectSession> {
    // What the caller added while the project was being made is in it now: from here on it is the session's own,
    // frozen as any other (a copy, so the caller's object stays its own).
    this.state = structuredClone(this.current);
    // A drawing started early that failed (the worker stopped meanwhile) is tried once more by the publication, as it
    // would have been had it been the first to ask.
    this.siteIcons.retry((await this.siteIcons.input(this.dir, this.state)).key);
    await this.ensureLocalDirs();
    const writing = perf.span('session.create.writeDocs');
    await this.writeAllDocs();
    writing();
    await this.publishGenerated(true);
    const saving = perf.span('session.create.localState');
    await this.saveLocalState();
    saving();
    return this;
  }

  /**
   * Open a project for editing. `preview.start` is called once its lock is held, anything a crash interrupted is
   * recovered and its documents are read and found sound, just before its generated files are published: what runs the
   * preview may start it then, while the publication goes on (src/main/controller.ts, prepareRuntime). An opening that
   * fails after that waits for `preview.stop` before it lets the lock go.
   */
  static open(dir: string, instanceId: string, opts: OpenOptions = {}): Promise<ProjectSession> {
    return timed('session.open', () => ProjectSession.openTimed(dir, instanceId, opts), (s) => ({ ok: !!s }))();
  }

  private static async openTimed(dir: string, instanceId: string, opts: OpenOptions): Promise<ProjectSession> {
    const s = new ProjectSession(dir);
    const checking = perf.span('session.open.formatCheck');
    // A project from a newer version is never written to, not even its local folders.
    await assertKnownFormat(dir, s.scanReader());
    checking();
    const locking = perf.span('session.open.lock');
    // The lock comes first: recovery must never touch a project another window is editing, and a project
    // that turns out to be locked is opened read-only with nothing written.
    await ensureDir(s.local());
    const lockErr = await s.acquireLock(instanceId, opts.force);
    locking();
    if (lockErr) throw lockErr;
    try {
      // The fence's claim, the ownership check and the local folders made and flushed.
      const preparing = perf.span('session.open.prepare');
      // Recovery writes too, so it runs fenced like any command.
      await s.serialize(async () => {
        if (!(await s.stillOwner())) {
          const now = await readLock(s.local('lock.json')).catch(() => null);
          throw new ProjectLockedError('The project was taken over while it was opening. Try again.', now ? judgeLock(s.local('lock.json'), now, instanceId, false).owner : { host: 'another computer', token: NO_LOCK });
        }
        await s.ensureLocalDirs();
        preparing();
        await s.openLocked(opts.preview?.start, opts.shown, opts.sweepLater);
      });
      // Queued now, so it runs ahead of every command asked for once the open is done.
      if (opts.sweepLater) void s.collectGarbage().catch(() => undefined);
    } catch (e) {
      // A preview started for this opening has gone before the lock does.
      await opts.preview?.stop(s).catch(() => undefined);
      await s.releaseLock();
      throw e;
    }
    return s;
  }

  /**
   * Open a project for inspection only (a newer format, or another app holds its lock). No lock is taken,
   * nothing is recovered or generated, and every command that would write is refused.
   */
  static async openReadOnly(dir: string, info: ReadOnlyInfo): Promise<ProjectSession> {
    const s = new ProjectSession(dir);
    s.readOnly = info;
    const read = await readProject(dir, { allowNewer: true });
    s.state = read.state;
    s.noteAbsentSources(read.state, read.raw);
    s.docs = stateToDocs(s.state);
    s.history = usableHistory(await readIfExists(s.local('history', 'history.json')).then((t) => (t ? (JSON.parse(t) as HistoryFile) : null)).catch(() => null));
    await s.versions.load().catch(() => undefined);
    await s.loadSavedCopies();
    const local = await readIfExists(s.local('state.json'));
    if (local) s.revision = JSON.parse(local).revision ?? 0;
    return s;
  }

  /**
   * Documents the format scan read, by project-relative path, each with the stat of the file it was read from. Kept
   * only for the open that follows the scan, which uses a text instead of reading its file again while the file's
   * stat is still that one (stillScanned).
   */
  private scanned: Map<string, { text: string; stamp: string }> | null = null;

  /** How the format scan reads each document: through one handle, keeping the text when its stat can stand for it. */
  private scanReader(): DocReader {
    const scanned = new Map<string, { text: string; stamp: string }>();
    this.scanned = scanned;
    return async (abs, rel) => {
      const started = Date.now();
      const read = await readTextAt(abs);
      if (!read) return null;
      perf.count('files.read');
      perf.count('docs.read');
      // Only a file left alone long enough that a later change cannot share its timestamps (statTrusted).
      if (read.st && statTrusted(read.st, started, this.settleMs)) scanned.set(rel, { text: read.text, stamp: stampOf(read.st) });
      return read.text;
    };
  }

  /**
   * The format scan's texts that still stand for their files, by project-relative path: each file's stat is the one
   * its text was read under, so it holds those bytes still. A file replaced or changed since (by recovery, by another
   * app) is read again, as is one whose stat cannot be compared (on Windows, a handle's and a path's differ in form).
   */
  private async stillScanned(): Promise<Map<string, string>> {
    const scanned = [...(this.scanned ?? [])];
    this.scanned = null;
    // Through safeJoin, as reading it would be: a folder swapped for a link since is read, and refused, as before.
    const now = await inBatches(scanned, ([rel]) => {
      try {
        return lookAt(safeJoin(this.dir, rel));
      } catch {
        return 'failed' as const;
      }
    });
    const out = new Map<string, string>();
    scanned.forEach(([rel, { text, stamp }], i) => {
      const st = now[i];
      if (typeof st === 'object' && stampOf(st) === stamp) out.set(rel, text);
    });
    return out;
  }

  private async openLocked(startPreview?: (s: ProjectSession) => void, shown?: (s: ProjectSession) => Promise<void>, sweepLater = false) {
    const s = this;
    const dir = this.dir;
    const recovering = perf.span('session.open.recover');
    await s.loadSavedCopies();
    await s.loadConflicts();
    // Both recoveries run before the documents are first read: a file a crash left broken may be one they restore.
    await s.recoverJournal();
    await s.recoverInterruptedRun();
    recovering();
    const reading = perf.span('session.open.read');
    const read = await readProject(dir, { overlay: s.pending, known: await s.stillScanned() });
    s.state = read.state;
    s.noteAbsentSources(read.state, read.raw);
    s.migrationDue = !!read.migration;
    s.docs = stateToDocs(s.state);
    reading({ docs: s.docs.size });
    const loading = perf.span('session.open.localState');
    s.history = usableHistory(await readIfExists(s.local('history', 'history.json')).then((t) => (t ? (JSON.parse(t) as HistoryFile) : null)));
    // Before the first sweep, which collects what no saved version names.
    await s.versions.load();
    // The version of a restore the app stopped recording is finished first (#1155): listed, or told of.
    const recorded = await s.versions.recordPending().catch((): PendingOutcome => ({ state: 'unreadable' }));
    if (recorded.state === 'pending')
      s.recoveryNotes.push(`Restoring “${recorded.version}” finished, but the site as it left it is not in Saved versions yet. ${recorded.reason} It is added the next time the project opens or a version is saved. Your work from before is saved as “${recorded.backup}”.`);
    else if (recorded.state === 'moved')
      s.recoveryNotes.push(`Restoring “${recorded.version}” finished, but the project’s version history was changed by something else before the site as it left it was added, so both were left as they are. Your work from before is saved as “${recorded.backup}”.`);
    else if (recorded.state === 'unreadable') s.recoveryNotes.push('The version of a restore that was still being saved could not be read, so it was left as it is.');
    const interrupted = await s.versions.takeRestoring().catch(() => null);
    // A restore whose version was noted is told of by what became of that version, above.
    const owed = recorded.state === 'unreadable' ? undefined : recorded.op;
    // Or listed already: only the note of the restore was left behind.
    if (!interrupted || (interrupted.op && (interrupted.op === owed || s.versions.versions.some((v) => v.id === interrupted.op)))) {
      // Told of above, or nothing to tell.
    } else if (interrupted.settled)
      s.recoveryNotes.push(`Restoring “${interrupted.version}” finished, but the site as it left it could not be saved as a version of its own. Your work from before is saved as “${interrupted.backup}” in History, under Saved versions.`);
    else
      s.recoveryNotes.push(`Restoring “${interrupted.version}” was interrupted, so some of it may be missing. Your work from before is saved as “${interrupted.backup}” in History, under Saved versions.`);
    const manifestAt = Date.now();
    const manifest = await readTextAt(join(dir, 'siteorigin', 'generated-manifest.json'));
    if (manifest) perf.count('files.read');
    s.generated = (manifest?.text ? JSON.parse(manifest.text) : null) ?? s.generated;
    if (manifest?.st && statTrusted(manifest.st, manifestAt, s.settleMs)) s.manifestRead = { text: manifest.text, stamp: stampOf(manifest.st) };
    const local = await readIfExists(s.local('state.json'));
    if (local) s.revision = JSON.parse(local).revision ?? 0;
    loading();
    // Validate the final state (after any rollback) before generating anything from it.
    const validating = perf.span('session.open.validate');
    // The checks the editor's first snapshot shows (diagnostics), worked out once for this state.
    const fatal = s.diagnostics().filter((d) => d.severity === 'error' && FATAL_CODES.has(d.code));
    validating();
    if (fatal.length) throw new ProjectFormatError(`This project's documents are inconsistent, so it was not opened to protect your site: ${fatal.slice(0, 4).map((d) => d.message).join(' ')}`);
    // A hold for a code component's file that a removal finished (a crash before the hold was let go) is let go now,
    // and one whose file went while the project was closed says so: only once the project read is sound.
    if (await s.reconcileHolds(s.state)) await s.saveConflicts();
    // Generating from another copy of the site's theme would restyle it before anyone edited anything.
    const pin = themePinProblem(s.state);
    if (pin) throw new ThemeUnavailableError(pin);
    // The library files an editable export kept aside for drafts (#1450) go back where the project uses them, before
    // anything looks for them: the preview, the publication, Project health's look at the library, the saved versions.
    const kept = keptDraftAssetsNote(await restoreDraftAssets(dir, s.state.assets.assets));
    if (kept) s.recoveryNotes.push(kept);
    startPreview?.(s);
    // With a file in conflict the update waits: its stored version is the user's to choose first.
    if (s.migrationDue && !s.pending.size) await s.publishMigration();
    else if (!shown) await s.publishGenerated(false);
    else await s.publishShown(shown);
    if (sweepLater) return;
    const sweeping = perf.span('session.open.sweep');
    await s.sweep();
    sweeping();
  }

  /**
   * The open's publication once the editor has been given the project to show (OpenOptions.shown), still under the
   * open's claim and ahead of every later command: generating and checking the website's files waits until then, so the
   * documents reach the editor first. Shown, the open stands whatever happens here: a publication that fails leaves the
   * save unfinished, so nothing more is written until the project is reopened (publishInstalled).
   */
  private async publishShown(shown: (s: ProjectSession) => Promise<void>) {
    this.conflictsBeforeOpen = [...this.conflicts];
    try {
      await shown(this).catch(() => undefined);
      // Looked at again once the editor has the project: a takeover meanwhile gets nothing written by this app.
      if (!(await this.stillOwner())) return;
      await this.publishGenerated(false);
    } catch {
      if (!this.readOnly) this.unsettled = true;
    } finally {
      this.conflictsBeforeOpen = null;
    }
  }

  /**
   * Store a project read in an older format in the current one. A copy of the old documents goes to the recovery
   * folder, then the update is published through the journal, so a crash leaves the old or new project, never a mix.
   */
  private async publishMigration(attempts = 3, approved?: ProjectState): Promise<void> {
    if (this.migrationFailed) return;
    const read = await readProject(this.dir);
    // After a reload, only the project that reload checked is published. A file changed since is loaded, and checked,
    // by the next reload, which updates the format then. The manifest is left out: the watcher never reloads it.
    if (approved && !sameDocs(stateToDocs(read.state), stateToDocs(approved), MANIFEST)) return;
    if (!read.migration) {
      this.migrationDue = false;
      return;
    }
    // The files may have changed since they were last validated.
    const fatal = validateState(read.state).filter((d) => d.severity === 'error' && FATAL_CODES.has(d.code));
    if (fatal.length) throw new ProjectFormatError(`This project's documents are inconsistent, so it was not updated to protect your site: ${fatal.slice(0, 4).map((d) => d.message).join(' ')}`);
    const { from, to } = read.migration;
    const backup = `migration-v${from}-to-v${to}-${Date.now()}`;
    // The journal describes the exact bytes that were validated, however they are formatted. Saving compares them
    // with the disk again, so a file edited since then is a conflict rather than something to overwrite.
    const before = new Map<string, string>();
    for (const path of stateToDocs(read.stored).keys()) {
      const stored = read.raw.get(path);
      if (stored !== undefined) before.set(path, stored);
    }
    const held = this.docs;
    // The update is worked out from one reading of every document, and a step can read documents it does not rewrite
    // (a page's values by its component's schema). A file changed or added while they were read (an edit the watcher
    // has not delivered yet) would leave that reading inconsistent, so it is read again instead of published.
    this.docs = before;
    const unloaded = await this.unloadedEdit(new Set()).finally(() => (this.docs = held));
    if (unloaded) {
      if (attempts > 1) return this.publishMigration(attempts - 1, approved);
      // After a reload, the files still changing bring another reload, which updates the format once they settle.
      if (approved) return;
      throw new DiskConflictError(unloaded);
    }
    for (const [path, stored] of before) await atomicWrite(this.local('recovery', backup, path), stored);
    this.docs = before;
    try {
      await this.persist(read.state, { label: 'Update project format', history: false, source: 'system', wholeProject: true });
    } catch (e) {
      this.docs = held;
      // A file changed outside the app is found before anything is written. After a reload, the change it made brings
      // the next reload, which updates the format then; nothing is lost, so the session is not held back for it.
      if (e instanceof DiskConflictError && approved) return;
      this.migrationFailed = !(e instanceof DiskConflictError);
      // Nothing more is written until the project is reopened: the save indicator says so, not that it can be retried.
      if (this.migrationFailed) this.emit('save-failed');
      throw e;
    }
    this.migrationDue = false;
    await atomicWrite(this.local('history', 'history.json'), toJson(this.history));
    this.recoveryNotes.push(`Updated this project to the current format. A copy of the previous version is in .siteorigin/recovery/${backup}.`);
  }

  private async ensureLocalDirs() {
    // Recorded durably: a journal written later relies on the blobs folder being there after a power loss. Each is
    // flushed even when it exists, since an app that stopped part way may have created it, or a file in it, without.
    for (const d of ['history/blobs', 'sessions', 'cache/dev', 'recovery']) await ensureDir(this.local(d));
    // Flushed together: each must be on disk before anything relies on it (recovery, a journal), not before the others,
    // and all have settled before this returns, failed or not.
    const flushed = [this.dir, this.local(), this.local('history'), this.local('history', 'blobs'), this.local('sessions')];
    await eachAtMost(flushed.length, flushed, (d) => syncDir(d));
  }

  /** The instance and per-acquisition token of the lock this session holds. */
  private lockOwner: string | null = null;
  private lockToken: string | null = null;
  /** none: never took a lock (project creation, tests); held; released: closed or taken over, so never writes again. */
  private lockState: 'none' | 'held' | 'released' = 'none';
  /** While a serialized command runs: whether it holds the claim on this lock's generation (no: another app does). */
  private fence: { claimed: boolean } | null = null;
  /** In this app, one user of this generation's claim at a time: commands, checks made from outside them, heartbeats. */
  private claimMutex: Promise<void> = Promise.resolve();
  /** The last time written by the heartbeat; each beat writes a later one, whatever this computer's clock does. */
  private lastBeat = 0;

  /**
   * Acquire the per-project process lock. Returns an error when another live app owns it.
   *
   * Ownership is a token, fresh for each acquisition, in lock.json. The name is only ever created exclusively, so two
   * openers can never both create it. Each lock generation has one claim file, created exclusively: the owner holds it
   * through every command that writes (so no takeover lands part way through one), and a taker holds it while it
   * checks the lock is still exactly what it judged, moves it aside, verifies what it moved and creates its own.
   * `force` takes over without the staleness check (the user's "Unlock"); given the generation the user was shown, it
   * takes over only that owner, so two Unlocks of one owner leave one successor rather than the second displacing it.
   */
  async acquireLock(instanceId: string, force: boolean | string = false): Promise<ProjectLockedError | null> {
    const lockPath = this.local('lock.json');
    const token = randomBytes(8).toString('hex');
    const body = toJson({ pid: process.pid, host: hostname(), instance: instanceId, token, started: new Date().toISOString() });
    const take = async (retired?: string) => {
      this.lockOwner = instanceId;
      this.lockToken = token;
      this.lockState = 'held';
      this.startHeartbeat();
      if (retired) await removeClaims(lockPath, retired);
      return null;
    };
    // The owner holds the claim while it writes, and another taker while it takes over: both take moments. An unlock
    // says the owner is gone, so a claim the owner itself left (it stopped part way through a command) is passed
    // over once it has sat unchanged for longer than any command takes; a live owner's save finishes first.
    const unlocking = force !== false;
    const deadline = performance.now() + (unlocking ? OWNER_CLAIM_GRACE_MS + 3000 : 2000);
    for (let attempt = 0; attempt < 6 && performance.now() < deadline; attempt++) {
      if (await createExclusive(lockPath, body)) return take();
      const seen = await readLock(lockPath);
      if (!seen) continue; // released meanwhile
      const verdict = judgeLock(lockPath, seen, instanceId, force);
      if (!verdict.stale) return new ProjectLockedError(`This project is already open in SiteOrigin Builder on ${verdict.owner.host}.`, verdict.owner);
      const claim = await claimLock(lockPath, verdict.generation, { holder: token, waitMs: Math.max(0, deadline - performance.now()), ownerGone: unlocking });
      if (!claim) continue;
      try {
        // Under the claim, the lock must still be the one judged: content, and time (a heartbeat changes only that).
        if (!sameLock(await readLock(lockPath), seen)) continue;
        if ((await removeIfUnchanged(lockPath, seen)) && (await createExclusive(lockPath, body))) return take(verdict.generation);
      } finally {
        await fs.rm(claim, { force: true }).catch(() => undefined);
      }
    }
    // Report whoever holds it now, so an unlock offered from here targets that owner.
    const now = await readLock(lockPath).catch(() => null);
    const owner = now ? judgeLock(lockPath, now, instanceId, false).owner : { host: 'another computer', token: NO_LOCK };
    return new ProjectLockedError('The project lock could not be acquired. Try again.', owner);
  }

  /**
   * Before a write: is this session still the lock's owner? Only a lock positively read back as this session's own
   * says yes. A takeover found here makes the session read-only at once; anything inconclusive says no.
   *
   * Inside a command (or while one runs), that command's claim on the lock generation covers the check. Called from
   * outside one (the preview, an export, the workspace save), it holds the claim just for the check.
   */
  async stillOwner(): Promise<boolean> {
    if (this.readOnly) return false;
    if (this.lockState === 'none') return true;
    if (this.lockState !== 'held') return false;
    // Only the command itself, or the heartbeat, moves the lock's time.
    if (this.fence) return (await this.checkLock(this.fence.claimed, false)) === 'mine';
    return (await this.withOwnClaim((claimed) => this.checkLock(claimed, false))) === 'mine';
  }

  /** Run `fn` holding this lock generation's claim (`claimed`: it could be had), one user in this app at a time. */
  private async withOwnClaim<T>(fn: (claimed: boolean) => Promise<T>): Promise<T> {
    const prior = this.claimMutex;
    let release!: () => void;
    this.claimMutex = new Promise<void>((r) => (release = r));
    await prior;
    try {
      const claim =
        this.lockState === 'held'
          ? await claimLock(this.local('lock.json'), this.lockToken!, { holder: this.lockToken!, waitMs: 1000 }).catch(async (e: unknown) => {
              // There is nowhere to make a claim in a folder that is gone.
              if (await this.checkFolder()) return null;
              throw e;
            })
          : null;
      try {
        return await fn(!!claim);
      } finally {
        if (claim) await fs.rm(claim, { force: true }).catch(() => undefined);
      }
    } finally {
      release();
    }
  }

  /** Run `fn` holding this lock generation's claim, so no takeover can land part way through it. */
  private async fenced<T>(fn: () => Promise<T>): Promise<T> {
    if (this.lockState !== 'held' || this.fence) return fn();
    return this.withOwnClaim(async (claimed) => {
      this.fence = { claimed };
      try {
        return await fn();
      } finally {
        this.fence = null;
      }
    });
  }

  /**
   * Whether the project folder is gone: moved, renamed or deleted while open. Once found gone, this session never writes
   * again (that would make a folder at the old address) and is read-only, saying why, even if the folder comes back.
   */
  async checkFolder(): Promise<boolean> {
    if (this.folderGone) return true;
    const missing = (path: string) => fs.stat(path).then(() => false, (e: NodeJS.ErrnoException) => e.code === 'ENOENT' || e.code === 'ENOTDIR');
    // While the lock is held, both of the project's own files are looked for: a manifest being replaced by another tool
    // never looks like the whole folder going, and an empty folder made again at the old address still does. Without
    // the lock (read-only, or taken over) there may rightly be no lock file, so only the folder says.
    const markers = this.lockState === 'held' ? [join(this.dir, MANIFEST_FILE), this.local('lock.json')] : [this.dir];
    if (!(await Promise.all(markers.map(missing))).every(Boolean)) return false;
    if (this.folderGone) return true;
    this.folderGone = true;
    this.stopHeartbeat();
    this.lockState = 'released';
    this.lockToken = null;
    this.readOnly = { ...FOLDER_GONE };
    // As for a takeover: whatever is writing into the folder, or running there, stops.
    this.emit('lock-lost');
    this.emit('history');
    return true;
  }

  /** Keep the lock fresh, and notice when another app has taken it over (it was unlocked from elsewhere). */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => void this.refreshLock().catch(() => undefined), LOCK_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /**
   * Refresh the lock's time; if another app now owns it, stop writing and become read-only. It waits for a command
   * in progress (never for one that only reads, such as an export), so a long read never starves the heartbeat.
   */
  refreshLock(): Promise<'mine' | 'lost' | 'unknown'> {
    return this.withOwnClaim((claimed) => this.checkLock(claimed, true));
  }

  /**
   * `claimed`: this generation's claim is held here, so no takeover can be part way through. `beat`: also move the
   * lock's time on, which is only safe while the claim is held by whoever is checking.
   */
  private async checkLock(claimed = !!this.fence?.claimed, beat = true): Promise<'mine' | 'lost' | 'unknown'> {
    if (this.lockState !== 'held') return 'unknown';
    // Another app holds this generation's claim: it is taking the lock over right now.
    if (!claimed) return 'unknown';
    const lockPath = this.local('lock.json');
    let seen: LockSeen | null;
    try {
      seen = await readLock(lockPath);
    } catch {
      return 'unknown';
    }
    const l = seen && parseLock(seen.text);
    // No lock because there is no folder is not a lock someone removed. Either look may have found the folder gone,
    // here or elsewhere, which already settled what this session is.
    if (!seen) await this.checkFolder();
    if (this.lockState !== 'held') return 'unknown';
    // Unreadable is most likely a lock being written: not proof of another owner, and not proof of this one.
    if (seen && !l) return 'unknown';
    // Another owner, or none: with this generation's claim held here no takeover can be part way through, so a
    // missing lock was released by a successor (or deleted). Either way this session must not write again, and is
    // never the one to re-create it.
    if (!seen || l!.token !== this.lockToken) {
      this.stopHeartbeat();
      this.lockState = 'released';
      this.lockToken = null;
      this.readOnly = {
        reason: seen ? 'Another SiteOrigin Builder took over this project, so it is read-only here. Close and reopen it to edit.' : 'This project’s lock was removed, so it is read-only here. Unlock it to edit.',
        canUnlock: true,
        lockToken: seen ? lockGeneration(seen) : NO_LOCK
      };
      this.emit('lock-lost');
      this.emit('history');
      return 'lost';
    }
    // Only the time changes, never the content, and only under the claim, so a heartbeat never touches a lock that
    // replaced this one. Each beat is later than the last even if this computer's clock steps back.
    if (beat) {
      this.lastBeat = Math.max(Date.now(), this.lastBeat + 1000);
      const t = new Date(this.lastBeat);
      await fs.utimes(lockPath, t, t).catch(() => undefined);
    }
    // Closed meanwhile: no longer this session's to use.
    return this.lockState === 'held' ? 'mine' : 'unknown';
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  async releaseLock() {
    this.stopHeartbeat();
    await this.serialize(async () => {
      if (this.lockState !== 'held') return;
      // Nothing after this may refresh or re-create the lock: a closed session never writes again.
      this.lockState = 'released';
      // Without the claim, a takeover is part way through: it replaces the lock itself.
      if (!this.fence?.claimed) return;
      const lockPath = this.local('lock.json');
      const seen = await readLock(lockPath).catch(() => null);
      if (seen && parseLock(seen.text)?.token === this.lockToken) await removeIfUnchanged(lockPath, seen);
    });
    this.lockToken = null;
  }

  // -------------------------------------------------------------------------
  // Blobs and journal
  // -------------------------------------------------------------------------

  private async putBlob(content: string): Promise<string> {
    const h = sha(content);
    const p = this.local('history', 'blobs', `${h}.json`);
    if (!existsSync(p)) await atomicWrite(p, content);
    return h;
  }

  /** Where each version in `blobs` (by hash) is stored, with its content. */
  private blobWrites(blobs: Map<string, string>): Array<{ path: string; data: string }> {
    return [...blobs].map(([h, content]) => ({ path: this.local('history', 'blobs', `${h}.json`), data: content }));
  }

  /** Store versions (by hash) for good, flushed together. */
  private async storeBlobs(blobs: Map<string, string>) {
    if (!blobs.size) return;
    const files = await stageWrites(this.blobWrites(blobs));
    try {
      for (const f of files) await f.replace();
      await syncStaged(files);
    } finally {
      await Promise.all(files.map((f) => f.discard()));
    }
  }

  private async getBlob(h: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(h)) throw new Error('Invalid history blob reference.');
    const content = await fs.readFile(this.local('history', 'blobs', `${h}.json`), 'utf8');
    if (sha(content) !== h) throw new Error('A history blob is corrupted.');
    return content;
  }

  /** The authored source a stored component definition names, if any. */
  private async sourcePathOf(blob: string | null | undefined): Promise<string | null> {
    if (!blob) return null;
    try {
      const def = JSON.parse(await this.getBlob(blob)) as { sourcePath?: unknown };
      return typeof def.sourcePath === 'string' && CUSTOM_SOURCE_RE.test(def.sourcePath) ? def.sourcePath : null;
    } catch {
      return null;
    }
  }

  private async diskContent(path: string): Promise<string | null> {
    return readIfExists(safeJoin(this.dir, path));
  }

  private async removeCanonical(path: string) {
    const abs = safeJoin(this.dir, path);
    await removeDurable(abs);
    await removeEmptyDirs(dirname(abs), join(this.dir, path.startsWith('src/') ? 'src' : 'siteorigin'));
  }

  // -------------------------------------------------------------------------
  // Canonical conflicts
  // -------------------------------------------------------------------------

  /**
   * Hold Builder's version of a document whose file was changed outside the app, replacing any earlier hold. `run`:
   * the hold an AI request's rollback leaves, with the version it tried to save (undefined: no usable reference).
   */
  private holdConflict(path: string, builder: string | null, reason: string, run?: { attempted: Attempt | undefined }, deletedCode?: { definitionId: string }) {
    this.pending.set(path, builder);
    this.attempts.delete(path);
    if (run?.attempted) this.attempts.set(path, run.attempted);
    this.conflicts = this.conflicts.filter((c) => c.path !== path);
    this.conflicts.push({ path, reason, kind: 'canonical', ...(builder === null ? { builderMissing: true } : {}), ...(run ? { aiRun: true } : {}), ...(deletedCode ? { deletedCode } : {}) });
  }

  private releaseConflict(path: string) {
    this.pending.delete(path);
    this.attempts.delete(path);
    this.conflicts = this.conflicts.filter((c) => c.path !== path);
  }

  /** Canonical conflicts outlive a restart, so a reopened project never silently takes the external version. */
  private async saveConflicts() {
    const file = this.local('conflicts.json');
    if (!this.pending.size) return void (await fs.rm(file, { force: true }));
    const list = [];
    for (const [path, builder] of this.pending) {
      const held = this.conflicts.find((c) => c.path === path);
      const reason = held?.reason ?? 'Changed outside SiteOrigin Builder.';
      // The attempted version is stored like Builder's, so garbage collection keeps it while the conflict is held.
      const a = this.attempts.get(path);
      const attempted = a && a.ref !== null && a.content !== undefined ? await this.putBlob(a.content) : a?.ref;
      const run = held?.aiRun ? { aiRun: true, ...(attempted === undefined ? {} : { attempted }) } : {};
      list.push({ path, reason, builder: builder === null ? null : await this.putBlob(builder), ...run, ...(held?.deletedCode ? { deletedCode: held.deletedCode.definitionId } : {}) });
    }
    await atomicWrite(file, toJson({ conflicts: list }));
  }

  private async loadConflicts() {
    const text = await readIfExists(this.local('conflicts.json'));
    if (!text) return;
    let list: Array<{ path: string; reason: string; builder: string | null; aiRun?: unknown; attempted?: unknown; deletedCode?: unknown }> = [];
    try {
      list = JSON.parse(text).conflicts ?? [];
    } catch {
      return;
    }
    let settled = false;
    for (const c of list) {
      if (typeof c?.path !== 'string' || !isCanonicalPath(c.path)) continue;
      const builder = c.builder === null ? null : await this.getBlob(String(c.builder)).catch(() => undefined);
      if (builder === undefined) continue;
      const run = c.aiRun === true ? { attempted: attemptAt(c.attempted) } : undefined;
      // A deleted code component's file put back with other code while the project was closed is a changed file (#1540).
      const deleted = typeof c.deletedCode === 'string' && builder !== null && (await this.diskContent(c.path)) === null;
      this.holdConflict(c.path, builder, deleted || typeof c.deletedCode !== 'string' ? String(c.reason ?? 'Changed outside SiteOrigin Builder.') : 'Changed outside SiteOrigin Builder.', run, deleted ? { definitionId: c.deletedCode as string } : undefined);
      await this.attemptContent(c.path);
      // Already settled outside the app (the file was put back): nothing to choose. What an AI request attempted is
      // kept first, as when it is settled in Project health; held until it is.
      if (settledOnDisk(c.path, await this.diskContent(c.path), builder) && (await this.saveAttempt(c.path).then(() => true, () => false))) {
        this.releaseConflict(c.path);
        settled = true;
        continue;
      }
      this.loadedHolds.add(c.path);
    }
    // Forgotten on disk too, or a later change to that file would bring the old choice back.
    if (settled) await this.saveConflicts();
  }

  /**
   * Settle one conflict. "restore" puts Builder's version back (the external file is copied to the recovery
   * folder first); "keep" accepts the external file, but only when the project is still valid with it.
   */
  resolveConflict(path: string, choice: ConflictChoice, opts: ConvertOptions = {}): Promise<{ ok: boolean; message?: string; definitionId?: string }> {
    // A code component's source put back, or a design's file converted, reaches the preview with the files generated
    // from it, as one update.
    return this.serialize(() => this.publishing(async () => {
      if (!(await this.stillOwner())) return { ok: false, message: this.readOnly?.reason ?? LOCK_UNCHECKED };
      if (this.activeRun) return { ok: false, message: 'Stop the AI before resolving conflicts.' };
      if (this.migrationFailed) return { ok: false, message: 'This project could not be updated to the current format. Close and reopen it.' };
      if (this.unsettled) return { ok: false, message: UNSETTLED };
      const conflict = this.conflicts.find((c) => c.path === path);
      // Nothing to convert is not a conversion made: only Keep and Restore find a settled file already settled.
      if (!conflict) return choice === 'convert' || choice === 'remove' ? { ok: false, message: 'That file is no longer in conflict.' } : { ok: true };
      if (choice === 'convert') return this.convertEditedLocked(conflict, opts);
      if (choice === 'remove') return this.removeDeletedCodeLocked(conflict);
      // A code component's file kept deleted would leave the component with no code (#1540): it is removed instead.
      if (choice === 'keep' && this.codeOwnerOf(path) && (await absent(safeJoin(this.dir, path)))) return { ok: false, message: `${path} is not there to keep. Put the file back, or remove the component.` };
      if (conflict.kind === 'generated') {
        if (choice !== 'restore') return { ok: false, message: 'A generated file can only be restored. Move your edits into the page or a code component.' };
        await this.restoreGeneratedLocked(path);
        return { ok: true };
      }
      const builder = this.pending.get(path) ?? null;
      let changed: HistoryEntry['docs'] = {};
      if (choice === 'restore') {
        const abs = safeJoin(this.dir, path);
        // Kept byte for byte, and listed under Saved copies, before it is replaced; a file that cannot be read is
        // never replaced unkept.
        const disk = await readFileAt(abs);
        if (disk === 'failed' || disk === 'changed') return { ok: false, message: `${path} could not be read, so it was not replaced. Check that it is a file you can open, then try again.` };
        // The attempted version first: one that cannot be read just now refuses the choice before anything is kept.
        await this.saveAttempt(path);
        if (disk !== 'missing') await this.saveCopy(path, 'canonical', 'external', disk.bytes);
        // Saved again while the copy was kept: that save is not replaced unkept either.
        const unchanged = async () => {
          // A file that was missing must still be missing, not merely one that cannot be looked at now.
          if (disk === 'missing' ? await absent(abs) : (await handleStamp(abs)) === disk.stamp) return true;
          throw new Error(`${path} changed while SiteOrigin Builder’s version was being put back, so it was not replaced. Try again.`);
        };
        if (builder === null) {
          await unchanged();
          await this.removeCanonical(path);
        } else {
          await atomicWrite(abs, builder, { beforeReplace: unchanged });
          this.absentSources.delete(path);
        }
        this.landing?.add(path);
        this.releaseConflict(path);
      } else {
        const overlay = new Map(this.pending);
        overlay.delete(path);
        let next: ProjectState;
        let migrated: boolean;
        let raw: Map<string, string>;
        try {
          const read = await readProject(this.dir, { overlay });
          next = read.state;
          migrated = !!read.migration;
          raw = read.raw;
        } catch (e) {
          return { ok: false, message: `The external version of ${path} could not be read, so it was not kept: ${(e as Error).message}` };
        }
        // Deleted while it was being kept: there is nothing to keep (#1540).
        if (this.codeOwnerOf(path) && !raw.has(path)) return { ok: false, message: `${path} is not there to keep. Put the file back, or remove the component.` };
        // Another code component's file deleted meanwhile is held, not taken as empty code (#1540).
        if (await this.holdDeletedCode(next, raw)) {
          await this.saveConflicts();
          this.emit('history');
        }
        const errors = this.introducedProblems(next);
        if (errors.length) return { ok: false, message: `Keeping the external version of ${path} would leave the site inconsistent: ${errors.slice(0, 3).map((d) => d.message).join(' ')} Restore SiteOrigin Builder's version instead, or fix the file.` };
        for (const def of Object.values(next.components)) {
          if (def.kind !== 'code' || def.source === this.state.components[def.id]?.source) continue;
          const bad = (await checkSvelteSource(def.source ?? '')).filter((p) => p.severity === 'error');
          if (bad.length) return { ok: false, message: `The external code for "${def.name}" has problems, so it was not kept: ${bad[0].message}` };
        }
        const pin = themePinProblem(next);
        if (pin) return { ok: false, message: `The external version of ${path} was not kept: ${pin}` };
        await this.saveAttempt(path);
        if (builder !== null) await this.saveCopy(path, 'canonical', 'builder', builder);
        // Frozen as it will be once it is the project, so its documents' texts are kept from here.
        const nextDocs = stateToDocs(frozen(next));
        changed = await this.diffDocs(this.docs, nextDocs);
        this.state = shareUnchanged(this.state, this.docs, next, nextDocs);
        this.docs = nextDocs;
        this.migrationDue ||= migrated;
        this.releaseConflict(path);
        this.noteAbsentSources(next, raw);
      }
      await this.saveConflicts();
      if (this.migrationDue && !this.pending.size) await this.publishMigration();
      // Kept, the external version is a state installed from disk; put back, SiteOrigin Builder's is the one it had.
      const changedFiles = choice === 'restore' ? await this.publishGenerated(false) : await this.publishInstalled();
      this.revision++;
      if (Object.keys(changed).length) await this.recordHistory(changed, { label: 'Keep external change', source: 'system' });
      await this.saveLocalState();
      // Kept, the external version brought every edited code with it (code with errors refuses the choice): nothing waits.
      if (choice !== 'restore') this.setRefusedSources(new Map(), { quiet: true });
      this.emit('changed', { revision: this.revision, changedDocs: Object.keys(changed), changedFiles, label: 'Resolve conflict', source: 'user' } satisfies SessionEvent);
      return { ok: true };
    }));
  }

  /**
   * A design's file edited outside the app made a project code component (#737): the edited file, as it reads from the
   * custom folder, is the component's code, and every placement of the design places it instead. Checked as any code is
   * before anything changes. Then the edited file is kept under Saved copies and claimed as the app's, so the save itself
   * (one step of history) writes the design's file again, once its journal is down: a save stopped at any point leaves
   * the edited file there, still listed, never lost, and one that did not start leaves the conflict as it was.
   */
  private async convertEditedLocked(conflict: Conflict, opts: ConvertOptions): Promise<{ ok: boolean; message?: string; definitionId?: string }> {
    const path = conflict.path;
    const refuse = (message: string) => ({ ok: false, message });
    if (conflict.kind !== 'generated' || !conflict.convert) return refuse('Only a component’s own file, edited outside SiteOrigin Builder, can become a code component.');
    // Asked here, as every way of making code is, whoever asks: only a plain yes allows it.
    if (opts.codeAllowed !== true) return refuse('Custom code needs Developer mode. Turn on Developer mode in Settings to convert this file into a code component.');
    // The project's own files are written by the conversion: a conflict on one of them is settled first.
    if (this.pending.size) return refuse('Settle the conflicts of the project’s own files first.');
    const design = designAt(this.state, path);
    if (!design || design.id !== conflict.convert.definitionId) return refuse('That file is no longer a component’s own file, so it was not converted.');
    const abs = safeJoin(this.dir, path);
    // Read again just before converting: what is converted, kept and checked is exactly what is there now.
    const disk = await readFileAt(abs);
    if (disk === 'missing') return refuse(`${path} is no longer there, so there is nothing to convert.`);
    if (disk === 'failed' || disk === 'changed') return refuse(`${path} could not be read, so it was not converted. Check that it is a file you can open, then try again.`);
    if (opts.expect !== undefined && sha(disk.bytes) !== opts.expect) return refuse(CHANGED_SINCE_COMPARED);
    const builder = await this.generatedContent(path);
    if (builder === undefined) return refuse('That file is no longer generated.');
    // Put back as SiteOrigin Builder's version meanwhile: nothing of anyone's to convert, and no conflict once looked at.
    if (disk.bytes.equals(typeof builder === 'string' ? Buffer.from(builder) : builder) || sha(disk.bytes) === this.generated.files[path]) {
      const changedFiles = await this.publishGenerated(false);
      this.emit('changed', { revision: this.revision, changedDocs: [], changedFiles, label: 'Resolve conflict', source: 'user' } satisfies SessionEvent);
      return refuse('The file is SiteOrigin Builder’s version again, so there is nothing to convert.');
    }
    const text = textOfBytes(disk.bytes);
    if (text === null) return refuse(`${path} is not text, so it can’t become a code component.`);
    const next = clone(this.state);
    let made: { definitionId: string; sourcePath: string };
    try {
      made = convertEditedDesign(next, design.id, text);
    } catch (e) {
      return refuse((e as Error).message);
    }
    const def = next.components[made.definitionId];
    // A contact form's copy for AI agents is written only while the site declares tools: the code imports the form.
    const adapters = new Map(Object.values(next.components).flatMap((d) => (isWebMcpForm(d) ? [[webMcpFormFile(d), defFile(d)] as const] : [])));
    def.source = await relocateSource(text, path, made.sourcePath, (target) => adapters.get(target));
    // The parts and slots the edited code shows for itself are declared too, as for any code saved.
    const names = await codeContractNames(def.source);
    if (names) declareCodeNames(def, names);
    const pin = themePinProblem(next);
    if (pin) return refuse(pin);
    // Held to what any code component is, with every import it makes found in the project as it will be.
    let files: Map<string, string>;
    try {
      files = this.generate(next, false);
    } catch (e) {
      return refuse(`The project could not be generated with the code component: ${(e as Error).message}`);
    }
    const resolve = componentSources(next.components);
    const exists = this.projectModules(next, files);
    const problems = (
      await checkSvelteSource(def.source, {
        filename: def.sourcePath,
        contract: { slots: def.slots, parts: def.parts, filled: filledSlots(next, def), variantAxes: def.variantAxes, properties: def.properties },
        // The design's properties, which the converted file must still take under the keys its design's file did.
        manifest: { ...def, designFile: true },
        resolve,
        modules: exists
      })
    ).filter((p) => p.severity === 'error');
    if (problems.length) return refuse(`The edited file can’t become a code component: ${problems.map((e) => (e.line ? `line ${e.line}: ` : '') + e.message).join(' ')} Fix the file and try again, or use SiteOrigin Builder’s version.`);
    const introduced = introducedDiagnostics(this.savingProblems(this.state), this.savingProblems(next));
    if (introduced.length) return refuse(`The edited file can’t become a code component: ${introduced.map((d) => d.message).join(' ')}`);
    // Kept byte for byte, and listed under Saved copies, before anything is replaced.
    await this.saveCopy(path, 'generated', 'external', disk.bytes);
    const claimed = this.generated.files[path];
    this.generated.files[path] = sha(disk.bytes);
    const before = this.state;
    try {
      await this.persist(next, { label: `Convert “${design.name}” to code`, source: 'user', wholeProject: true });
    } catch (e) {
      const why = (e as Error).message;
      // Stopped part way (or unsure how far it got): reopening finishes it, or finds the file still in conflict.
      if (this.state !== before || this.unsettled) return refuse(`The conversion could not be finished: ${why} Close and reopen the project: it then finishes the conversion, or shows the file in conflict as it was.`);
      // Nothing of it installed: the edited file is someone else's again, still in conflict, to choose for again.
      if (claimed === undefined) delete this.generated.files[path];
      else this.generated.files[path] = claimed;
      return refuse(e instanceof DiskConflictError ? `${why} Nothing was converted.` : `The conversion could not be saved, so nothing was converted: ${why}`);
    }
    // Saved again outside the app while it was being converted: that newer version stays, listed again.
    if (this.conflicts.some((c) => c.path === path)) return { ok: true, definitionId: made.definitionId, message: `${path} was saved again while it was being converted. The version read is now the code component; the newer one is listed again.` };
    return { ok: true, definitionId: made.definitionId };
  }

  /**
   * Remove a code component whose file was deleted outside the app, with every placement of it, as one step of History
   * that Undo takes back, file and all (#1540). Checked as any edit is before anything changes; refused while the file
   * is back, while other components need it, or while another file is in conflict. The hold stays until the removal is
   * saved, so one that fails leaves the file to be put back.
   */
  private async removeDeletedCodeLocked(conflict: Conflict): Promise<{ ok: boolean; message?: string }> {
    const path = conflict.path;
    const refuse = (message: string) => ({ ok: false, message });
    if (!conflict.deletedCode) return refuse('Only a code component whose file was deleted can be removed here.');
    const id = conflict.deletedCode.definitionId;
    const def = Object.hasOwn(this.state.components, id) ? this.state.components[id] : undefined;
    // The component has gone already (removed with its file before a crash, say): there is nothing left to hold.
    if (!def || def.sourcePath !== path) {
      this.releaseConflict(path);
      await this.saveConflicts();
      this.emit('history');
      return { ok: true };
    }
    // Other deleted code components' files may stay held: this writes none of them. Any other conflict is settled first.
    const others = [...this.pending.keys()].filter((p) => p !== path);
    if (others.some((p) => !this.conflicts.find((c) => c.path === p)?.deletedCode)) return refuse('Settle the other file conflicts first.');
    // Another deleted file put back, and not loaded yet, may now need this component: it is loaded first.
    for (const p of others) if (!(await absent(safeJoin(this.dir, p)))) return refuse(`${p} is back and still being loaded, so “${def.name}” was not removed. Try again in a moment.`);
    if (!(await absent(safeJoin(this.dir, path)))) return refuse(`${path} is back, so “${def.name}” was not removed. Compare the versions, then choose again.`);
    const dependents = dependentsOf(this.state, def.id);
    if (dependents.length) return refuse(`“${def.name}” is used in the code of ${dependents.map((d) => `“${d.name}”`).join(', ')}, so it was not removed. Change that code first, or put the file back.`);
    const { operations, placements } = removalWithPlacements(this.state, def.id);
    let next: ProjectState;
    try {
      next = applyOperations(this.state, operations).state;
    } catch (e) {
      return refuse(`“${def.name}” could not be removed: ${(e as Error).message}`);
    }
    const introduced = introducedDiagnostics(this.savingProblems(this.state), this.savingProblems(next));
    if (introduced.length) return refuse(`“${def.name}” could not be removed: ${introduced.map((d) => d.message).join(' ')}`);
    const builder = this.pending.get(path) ?? null;
    const before = this.state;
    // Released for the save, which the hold would refuse: History's step keeps the code last loaded as the file's before.
    // Its placements were found in the project as loaded: one added outside the app since (a page saved in another
    // editor the watch has not delivered) would be left placing a component that is gone, so the save, worked out from
    // the whole project, waits for it.
    this.releaseConflict(path);
    try {
      await this.persist(next, { label: placements ? `Remove “${def.name}” and its ${placements === 1 ? 'placement' : `${placements} placements`}` : `Remove “${def.name}”`, source: 'user', absent: new Set([path]), wholeProject: true });
    } catch (e) {
      const why = (e as Error).message;
      if (this.state !== before || this.unsettled) return refuse(`The removal could not be finished: ${why} Close and reopen the project to finish it.`);
      this.holdConflict(path, builder, conflict.reason, undefined, conflict.deletedCode);
      this.emit('history');
      return refuse(e instanceof DiskConflictError ? `${why} Nothing was removed.` : `The removal could not be saved, so nothing was removed: ${why}`);
    }
    await this.saveConflicts();
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Comparing conflict versions, and saved copies
  // -------------------------------------------------------------------------

  /**
   * The versions of a file in conflict, as text to compare: SiteOrigin Builder's, and the one on disk now. A conflict an
   * AI request's rollback left also shows the version that request tried to save.
   */
  async compareConflict(path: string): Promise<{ ok: boolean; builder?: FileText; disk?: FileText; attempted?: FileText; message?: string }> {
    const conflict = this.conflicts.find((c) => c.path === path);
    if (!conflict) return { ok: false, message: 'That file is no longer in conflict.' };
    let builder: string | Buffer | null | undefined;
    try {
      builder = conflict.kind === 'canonical' ? (this.pending.get(path) ?? null) : conflict.builderMissing ? null : await this.generatedContent(path);
    } catch {
      builder = undefined;
    }
    const disk = await readText(safeJoin(this.dir, path));
    const shown = (v: string | Buffer | null | undefined): FileText => (v === undefined ? { state: 'unreadable' } : v === null ? { state: 'missing' } : textOf(v));
    return { ok: true, builder: shown(builder), disk, ...(conflict.aiRun ? { attempted: shown(await this.attemptContent(path)) } : {}) };
  }

  /** What a saved copy holds. Only a copy on the list is read, and only as the plain file it was saved as. */
  async readSavedCopy(id: string): Promise<{ ok: boolean; content?: FileText; message?: string }> {
    const copy = this.savedCopies.find((c) => c.id === id);
    if (!copy) return { ok: false, message: 'That saved copy is no longer listed.' };
    if (copy.removed) return { ok: true, content: { state: 'missing' } };
    // A link in the recovery folder could lead anywhere: only a plain file is read.
    const abs = (() => {
      try {
        return safeJoin(this.dir, copy.file);
      } catch {
        return null;
      }
    })();
    const plain = abs !== null && (await fs.lstat(abs).then((st) => st.isFile(), () => false));
    return { ok: true, content: plain ? await readText(abs) : { state: 'missing' } };
  }

  /** Take a saved copy off the list. Its file stays in the recovery folder. */
  dismissSavedCopy(id: string): Promise<{ ok: boolean; message?: string }> {
    return this.serialize(async () => {
      if (!(await this.stillOwner())) return { ok: false, message: this.readOnly?.reason ?? LOCK_UNCHECKED };
      if (!this.savedCopies.some((c) => c.id === id)) return { ok: true };
      // The list on disk is the one to take it off.
      let listed: SavedCopy[];
      try {
        listed = await this.loadSavedCopies({ forWrite: true });
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
      await atomicWrite(safeJoin(this.dir, `${LOCAL_DIR}/recovery/${SAVED_COPIES}`), toJson({ copies: listed.filter((c) => c.id !== id) }));
      const gone = this.savedCopies.find((c) => c.id === id);
      if (gone) this.dismissedCopies.set(id, gone);
      this.savedCopies = this.savedCopies.filter((c) => c.id !== id);
      return { ok: true };
    });
  }

  /**
   * Put a saved copy taken off the list in this opening back on it (Undo), newest first as the list is kept. Only an
   * entry this opening took off is put back, and only while its file is still a plain file in the recovery folder.
   */
  restoreSavedCopy(id: string): Promise<{ ok: boolean; message?: string }> {
    return this.serialize(async () => {
      if (!(await this.stillOwner())) return { ok: false, message: this.readOnly?.reason ?? LOCK_UNCHECKED };
      if (this.savedCopies.some((c) => c.id === id)) return { ok: true };
      const copy = this.dismissedCopies.get(id);
      if (!copy) return { ok: false, message: 'That saved copy can’t be put back on the list.' };
      const plain = copy.removed || (await (async () => (await fs.lstat(safeJoin(this.dir, copy.file))).isFile())().catch(() => false));
      if (!plain) return { ok: false, message: 'That saved copy’s file is no longer in the recovery folder, so it wasn’t put back on the list.' };
      let listed: SavedCopy[];
      try {
        listed = await this.loadSavedCopies({ forWrite: true });
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
      const newest = (a: SavedCopy, b: SavedCopy) => b.savedAt - a.savedAt;
      await atomicWrite(safeJoin(this.dir, `${LOCAL_DIR}/recovery/${SAVED_COPIES}`), toJson({ copies: [...listed.filter((c) => c.id !== id), copy].sort(newest) }));
      this.savedCopies = [...this.savedCopies, copy].sort(newest);
      this.dismissedCopies.delete(id);
      return { ok: true };
    });
  }

  /**
   * The text of the version an AI request tried to save (null: it removed the file; undefined: it cannot be read). A
   * blob that could not be read is read again each time, until it can be; one gone or damaged is marked `lost`.
   */
  private async attemptContent(path: string): Promise<string | null | undefined> {
    const a = this.attempts.get(path);
    if (!a) return undefined;
    if (a.ref === null) return null;
    if (a.content === undefined) {
      try {
        const text = await fs.readFile(this.local('history', 'blobs', `${a.ref}.json`), 'utf8');
        if (sha(text) === a.ref) a.content = text;
        a.lost = a.content === undefined;
      } catch (e) {
        // Missing, or something other than a file where it should be: damaged, not merely unreadable for now.
        a.lost = isMissing(e) || (e as NodeJS.ErrnoException).code === 'EISDIR';
      }
    }
    return a.content;
  }

  /**
   * List the version an AI request tried to save under Saved copies, as its conflict is settled, however it is: it is
   * never offered as a choice, so this copy is the only place it stays. A removal attempted is listed with no file.
   * One that cannot be read just now refuses (the conflict stays, to try again); one whose blob is gone or damaged has
   * nothing left to keep, and never keeps the conflict from being settled.
   */
  private async saveAttempt(path: string) {
    const attempted = await this.attemptContent(path);
    if (attempted !== undefined) return this.saveCopy(path, 'canonical', 'attempted', attempted);
    if (this.attempts.get(path)?.lost === false) throw new Error(`The version the AI request tried to save for ${path} could not be read, so nothing was changed. Try again.`);
  }

  /**
   * Keep one version of a file in conflict before the other replaces it, and list it under Saved copies so it can be
   * found again, also after the project is reopened. The copy is listed before anything is replaced: a crash between
   * the two leaves it in the recovery folder, never lost.
   */
  private async saveCopy(path: string, kind: Conflict['kind'], side: SavedCopy['side'], bytes: string | Buffer | null) {
    const id = randomBytes(8).toString('hex');
    const savedAt = Date.now();
    // Named for its file, side and time, and made unique by its ID, so it never replaces an earlier copy. The file's
    // own name is cut short: the list says where it came from in full, and a deep route must not make a name too
    // long to save.
    const name = `${savedAt}-${id}-${path.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)}.${side}`;
    // Only ever inside this project: a recovery folder that is a link elsewhere is not written through.
    const file = `${LOCAL_DIR}/recovery/${name}`;
    const list = safeJoin(this.dir, `${LOCAL_DIR}/recovery/${SAVED_COPIES}`);
    // A version that has no file (an AI request that removed it) is listed with nothing written.
    if (bytes !== null) await atomicWrite(safeJoin(this.dir, file), bytes);
    // Read again first: the list on disk is the one to add to, entries whose copy is away for now included.
    const listed = await this.loadSavedCopies({ forWrite: true });
    const copy: SavedCopy = { id, path, kind, side, savedAt, file, ...(bytes === null ? { removed: true } : {}) };
    await atomicWrite(list, toJson({ copies: [copy, ...listed] }));
    this.savedCopies = [copy, ...this.savedCopies];
  }

  /**
   * The saved copies list as stored, keeping only well-formed entries whose copy is a plain file in the recovery
   * folder. A list that cannot be read lists nothing. `forWrite` (before it is written again): a list that is not
   * a list of copies is moved aside under another name first, and one that cannot be read now (locked, or no
   * permission) refuses the write, so the entries either holds are never written over.
   */
  private async loadSavedCopies(opts: { forWrite?: boolean } = {}): Promise<SavedCopy[]> {
    // Never through a recovery folder that is a link out of the project: not even to set a list aside.
    const file = opts.forWrite ? safeJoin(this.dir, `${LOCAL_DIR}/recovery/${SAVED_COPIES}`) : this.local('recovery', SAVED_COPIES);
    let list: unknown = [];
    let text: string | null = null;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (e) {
      if (!isMissing(e) && opts.forWrite) throw new Error(`The list of saved copies (${LOCAL_DIR}/recovery/${SAVED_COPIES}) could not be read, so nothing was changed: ${(e as Error).message}`);
    }
    if (text !== null) {
      try {
        list = JSON.parse(text).copies;
      } catch {
        list = undefined;
      }
      if (!Array.isArray(list)) {
        list = [];
        if (opts.forWrite) await fs.rename(file, this.local('recovery', `copies-unreadable-${Date.now()}.json`));
      }
    }
    // Every well-formed entry is kept in the list as stored, so a copy that is away for a while (a sync tool moved
    // it) is listed again once it is back; only those whose copy is a plain file here now are shown.
    const all: SavedCopy[] = [];
    const shown: SavedCopy[] = [];
    for (const c of Array.isArray(list) ? list : []) {
      if (!isSavedCopy(c) || all.some((x) => x.id === c.id)) continue;
      const entry: SavedCopy = { id: c.id, path: c.path, kind: c.kind, side: c.side, savedAt: c.savedAt, file: c.file, ...(c.removed ? { removed: true } : {}) };
      all.push(entry);
      // One entry that cannot be checked (it leads outside the project) is left out; the rest still are shown. A
      // version that had no file has none to check.
      const plain = c.removed || (await (async () => (await fs.lstat(safeJoin(this.dir, c.file))).isFile())().catch(() => false));
      if (plain) shown.push(entry);
    }
    this.savedCopies = shown.sort((a, b) => b.savedAt - a.savedAt);
    return all;
  }

  /**
   * What SiteOrigin Builder generates for a file now: the clean source, a theme file copied from its pack, or one of
   * the website's icons (undefined while they cannot be made).
   */
  private async generatedContent(path: string): Promise<string | Buffer | undefined> {
    const clean = this.generate(this.state, false);
    const copy = packFileCopies(this.state).find((c) => c.path === path);
    if (!clean.has(path) && !copy && SITE_ICON_PATHS.includes(path)) return (await this.siteIcons.make(this.dir, this.state)).files?.get(path);
    return clean.get(path) ?? (copy ? await readPackFile(copy.pack, copy.file) : undefined);
  }

  /**
   * Make the website's icons again when what they are made from changed with no document changing (a favicon file put
   * back or replaced in the folder, or a set a save stopped waiting for now ready), publishing them as any save does.
   * Gives the key of what the publication made them from, whether it carried them and, when not, whether they are
   * still being drawn (rather than impossible to make now), or null when the project is not this app's to write.
   */
  refreshSiteIcons(): Promise<{ key: string; published: boolean; drawing: boolean } | null> {
    return this.serialize(async () => {
      if (this.readOnly || this.unsettled || !(await this.stillOwner())) return null;
      const key = await this.siteIconSource();
      // Published already, unless a newer drawing of the same input has been made since (a picture tried again after
      // the monogram stood in for it).
      const made = this.siteIcons.madeId(key);
      if (this.iconsPublished?.key === key && (made === null || made === this.iconsPublished.id)) return { key, published: true, drawing: false };
      const before = JSON.stringify(this.conflicts);
      const changedFiles = await this.publishInstalled();
      if (changedFiles.length || JSON.stringify(this.conflicts) !== before) this.emit('changed', { revision: this.revision, changedDocs: [], changedFiles, label: 'Update site icons', source: 'system' } satisfies SessionEvent);
      const asked = this.iconsAsked ?? key;
      const published = asked === this.iconsPublished?.key;
      return { key: asked, published, drawing: !published && this.siteIcons.drawing(asked) };
    });
  }

  /**
   * Wait, without holding the project's lock, until the website's icons for the project as it is now are made or
   * cannot be: an export then finds them ready rather than going out with icons a save stopped waiting for.
   */
  async prepareSiteIcons(): Promise<void> {
    if (!this.readOnly) await this.siteIcons.make(this.dir, this.state, Infinity);
  }

  /** The key naming what the website's icons are made from now, read from the project or from a copy of it in `dir`. */
  async siteIconSource(dir = this.dir): Promise<string> {
    return (await this.siteIcons.input(dir, this.state)).key;
  }

  /** What the icons the last finished publication carried are made from, or null before any could be made. */
  get siteIconsPublished(): string | null {
    return this.iconsPublished?.key ?? null;
  }

  /** Whether the icons made from `key` are being drawn, or waiting to be; or cannot be made now. */
  siteIconsDrawing(key: string): boolean {
    return this.siteIcons.drawing(key);
  }
  siteIconsUnmakeable(key: string): boolean {
    return this.siteIcons.unmakeable(key);
  }

  /**
   * A change stopped because a file was saved outside the app: refused cleanly, to be tried again once the file is
   * read, unless part of the change was already on disk, which only reopening the project can finish.
   */
  private diskConflict(e: DiskConflictError): NonNullable<ApplyResult['error']> {
    // Its journal could not be confirmed gone, so nothing more is saved; yet there is none for reopening to finish.
    if (this.unsettled && this.writeFailure(e) === 'blocked') return { code: 'CONFLICT', message: STOPPED_UNSAVED, recoverable: false, details: { save: 'blocked' } };
    // Its journal is on disk: reopening finishes it, so the editor keeps the typed text only to copy (#1435).
    return this.unsettled ? { code: 'CONFLICT', message: STOPPED_PART_WAY, recoverable: false, ...(this.writeFailure(e) === 'unfinished' ? { details: { save: 'unfinished' } } : {}) } : { code: 'CONFLICT', message: e.message, recoverable: true };
  }

  /** Before/after blobs for every document that differs between two document maps. */
  private async diffDocs(prev: Map<string, string>, next: Map<string, string>): Promise<HistoryEntry['docs']> {
    const changed: HistoryEntry['docs'] = {};
    for (const p of new Set([...prev.keys(), ...next.keys()])) {
      const b = prev.get(p);
      const a = next.get(p);
      if (b === a) continue;
      changed[p] = { before: b === undefined ? null : await this.putBlob(b), after: a === undefined ? null : await this.putBlob(a) };
    }
    return changed;
  }

  /** Whether `disk` is the stored version `blob` of `path`, as a save's check of a file before replacing it sees it. */
  private async sameAsVersion(path: string, disk: string | null, blob: string | null): Promise<boolean> {
    if (disk === null || blob === null) return false;
    const version = await this.getBlob(blob).catch(() => null);
    return version !== null && sameContent(path, disk, version);
  }

  /** Roll forward an interrupted publication: every intended write is stored as a blob before any file is replaced. */
  private async recoverJournal() {
    const j = await readIfExists(this.local('journal.json'));
    // One that is there but cannot be read is never taken for none: the next save would replace the only copy of what
    // it was saving (#1435).
    if (j === null && (await fs.lstat(this.local('journal.json')).then(() => true, () => false)))
      throw new Error('This project has an interrupted save that could not be read. Check that you can read and write the files in its .siteorigin folder, then open it again.');
    if (!j) return;
    const keepAside = async (why: string) => {
      await atomicWrite(this.local('recovery', `journal-${Date.now()}.json`), j);
      await removeDurable(this.local('journal.json'));
      this.recoveryNotes.push(why);
    };
    let journal: Partial<Journal> & Pick<Journal, 'writes' | 'deletes'>;
    try {
      journal = JSON.parse(j);
    } catch {
      return keepAside('An interrupted save could not be read, so it was set aside. Your files were not changed.');
    }
    // Only well-formed journals for canonical documents, with verified blobs, are ever replayed.
    if (!journal || !Array.isArray(journal.writes) || !Array.isArray(journal.deletes)) return keepAside('An interrupted save could not be read, so it was set aside. Your files were not changed.');
    // Checked again under the lock: a newer app may have written this journal after the check before it.
    if (typeof journal.schemaVersion === 'number' && journal.schemaVersion > SCHEMA_VERSION)
      throw new ProjectFormatError(`This project has an unfinished save from a newer version of SiteOrigin Builder (format ${journal.schemaVersion}). Update the app to edit it.`, true);
    const allPaths = [...journal.writes, ...journal.deletes].map((e) => e?.path);
    const bad = allPaths.some((p) => typeof p !== 'string' || !isCanonicalPath(p)) || new Set(allPaths).size !== allPaths.length;
    if (bad) return keepAside('An interrupted save referred to files it should not touch, so it was set aside.');
    // Versions the change had not stored yet travel with it: stored first, since its writes and History name them. One
    // that is not what its name says is never stored, so a change that needs it is set aside below.
    if (journal.versions && typeof journal.versions === 'object' && !Array.isArray(journal.versions)) {
      const named = new Set<unknown>([...journal.writes.flatMap((w) => [w?.blob, w?.before]), ...journal.deletes.map((d) => d?.before)]);
      const steps = (journal.history as { entries?: unknown } | undefined)?.entries;
      if (Array.isArray(steps)) for (const e of steps) for (const d of Object.values((e as { docs?: Record<string, { before?: unknown; after?: unknown }> } | null)?.docs ?? {})) named.add(d?.before).add(d?.after);
      for (const [h, content] of Object.entries(journal.versions)) {
        if (!named.has(h) || !/^[a-f0-9]{64}$/.test(h) || typeof content !== 'string' || sha(content) !== h) continue;
        if (!(await this.getBlob(h).then(() => true, () => false))) await atomicWrite(this.local('history', 'blobs', `${h}.json`), content);
      }
    }
    const contents = new Map<string, string>();
    for (const w of journal.writes) {
      const c = await this.getBlob(w.blob).catch(() => null);
      if (c === null) return keepAside('An interrupted save was missing data, so it was set aside. Your files were not changed.');
      contents.set(w.path, c);
    }
    const marker = this.local('sessions', 'active-run.json');
    let markerText: string | null;
    try {
      markerText = await fs.readFile(marker, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      markerText = null;
    }
    if (typeof journal.finishRun === 'string') {
      // Finishing a run only records its step: the journal is only acted on when that step is whole and applied,
      // and belongs to the run still marked. Otherwise it is set aside and the marked run is rolled back.
      let run: { id?: unknown; paths?: Record<string, { before?: unknown; after?: unknown }> } | null = null;
      let readable = true;
      try {
        run = markerText === null ? null : JSON.parse(markerText);
      } catch {
        readable = false;
      }
      // The step is evidence of the finish in any format this app reads, so one saved just before an update counts;
      // an older one only for a completion that changes no files itself, as every completion is written.
      const older = readableJournalHistory(journal.history) && !journal.writes.length && !journal.deletes.length;
      const h = usableJournalHistory(journal.history) || older ? journal.history : null;
      const at = h ? h.entries.findIndex((e) => e?.runId === journal.finishRun) : -1;
      const docs = at >= 0 ? h!.entries[at].docs : null;
      const blobs = docs && typeof docs === 'object' && Object.keys(docs).length ? Object.values(docs).flatMap((d) => (d && typeof d === 'object' ? [d.before, d.after] : [undefined])) : null;
      let whole = at >= 0 && at < h!.cursor && !!blobs && (await Promise.all(blobs.map((b) => (b === null ? true : this.getBlob(String(b)).then(() => true, () => false))))).every(Boolean);
      // The step must cover every file the marked run changed, from its checkpoint to what it left.
      if (whole && run?.paths && typeof run.paths === 'object')
        for (const [path, d] of Object.entries(run.paths)) if (d && d.before !== d.after && (docs![path]?.before !== d.before || docs![path]?.after !== d.after)) whole = false;
      // A marker that is there must be this run's (one already cleared by an earlier recovery is fine).
      const sameRun = markerText === null || (readable && run?.id === journal.finishRun);
      if (!sameRun || !whole)
        return keepAside(readable ? 'An interrupted AI change could not be finished, so it was undone instead.' : 'An interrupted AI change could not be finished or undone, so its changes were kept as they are.');
    }
    // An edit saved into a waiting run's checkpoint (#1281) carries the marker naming that checkpoint, which replaces the
    // run's own once the save is done. Checked before anything is rolled forward: one that cannot stand in for the marker
    // on disk leaves the save undone, so the run's recovery restores the checkpoint as it was before the edit.
    let runMarker: RunMarker | null = null;
    if (journal.runMarker !== undefined && markerText !== null) {
      const fit = await this.markerFit(journal.runMarker, markerText);
      if (fit === 'unfit') return keepAside('An edit saved while the AI waited for an answer could not be finished, so it was set aside. The AI change was undone.');
      if (fit === 'fits') runMarker = journal.runMarker as RunMarker;
    }
    let conflicts = 0;
    for (const w of journal.writes) {
      // An earlier recovery of this journal already held this file for the user to choose.
      if (this.loadedHolds.has(w.path)) {
        conflicts++;
        continue;
      }
      const disk = await this.diskContent(w.path);
      const h = disk === null ? null : sha(disk);
      if (h === w.blob) continue; // already applied
      // A file that differs from the version this change replaced only in its formatting (saved so by another editor,
      // which the save's own check let pass) is that version: its replacement was lost, not overtaken.
      if (h !== w.before && !(await this.sameAsVersion(w.path, disk, w.before))) {
        // Changed by someone else since: keep their file, and hold this batch's version so the documents
        // the project is opened with stay consistent with the rest of the batch until the user chooses.
        conflicts++;
        this.holdConflict(w.path, contents.get(w.path)!, 'Changed outside SiteOrigin Builder while a save was interrupted.');
        continue;
      }
      await atomicWrite(safeJoin(this.dir, w.path), contents.get(w.path)!);
    }
    // Sources are deleted before the definitions that name them, so a definition already gone while its source is
    // still here was deleted outside the app. Before this save deletes the source too, that is recorded in the marker
    // of the AI run it belongs to (if any), durably: rolling the run back then reports the deletion rather than
    // bringing the definition back, however many times recovery is interrupted.
    const deletedOutside: string[] = [];
    for (const d of journal.deletes) {
      if (!COMPONENT_DOC_RE.test(d.path) || (await this.diskContent(d.path)) !== null) continue;
      const source = await this.sourcePathOf(d.before);
      if (source && journal.deletes.some((x) => x.path === source) && (await this.diskContent(source)) !== null) deletedOutside.push(d.path);
    }
    if (deletedOutside.length && markerText !== null) {
      let run: { deletedOutside?: unknown } | null = null;
      try {
        run = JSON.parse(markerText);
      } catch {
        /* an unreadable marker is discarded by run recovery anyway */
      }
      // Written before the source goes; if it cannot be, recovery stops here and is tried again on the next open.
      if (run) {
        const known = Array.isArray(run.deletedOutside) ? run.deletedOutside : [];
        await atomicWrite(marker, toJson({ ...run, deletedOutside: [...new Set([...known, ...deletedOutside])] }));
      }
    }
    for (const d of journal.deletes) {
      if (this.loadedHolds.has(d.path)) {
        conflicts++;
        continue;
      }
      const disk = await this.diskContent(d.path);
      if (disk === null) {
        // Removed before the interruption: the folders that leaves empty go too, as they do after a whole delete.
        await removeEmptyDirs(dirname(safeJoin(this.dir, d.path)), join(this.dir, d.path.startsWith('src/') ? 'src' : 'siteorigin'));
        continue;
      }
      if (sha(disk) !== d.before && !(await this.sameAsVersion(d.path, disk, d.before))) {
        conflicts++;
        this.holdConflict(d.path, null, 'Changed outside SiteOrigin Builder while a save was interrupted.');
        continue;
      }
      // A collection's settings stay while any of its entries is still there (one added outside the app since, or one
      // held above): an entry is never left without its collection, which would stop the project opening.
      const settingsOf = collectionPathOf(d.path);
      if (settingsOf && settingsOf.entryId === undefined) {
        const left = await fs.readdir(join(this.dir, DOC_DIR, 'collections', settingsOf.collectionId, 'entries')).catch(() => [] as string[]);
        if (left.some((f) => isCanonicalPath(`${DOC_DIR}/collections/${settingsOf.collectionId}/entries/${f}`))) continue;
      }
      await this.removeCanonical(d.path);
    }
    // A file the interrupted save had already replaced or removed may not have reached the disk for good yet.
    await this.syncFoldersOf(allPaths as string[]);
    // Held versions are recorded before the journal goes, so a second crash cannot lose them.
    await this.saveConflicts();
    // The undo position and revision the change left, then the run it finished: all before the journal goes. Steps
    // saved in an older format are not installed. When the saved History is of that format too, and so is dropped on
    // reading, where the change leaves each AI step is kept in its place, not where it stood before (issue 276).
    const historyPath = this.local('history', 'history.json');
    if (usableJournalHistory(journal.history)) await atomicWrite(historyPath, toJson(journal.history));
    else if (readableJournalHistory(journal.history) && olderFormat((journal.history as HistoryFile).schemaVersion)) {
      // Only History that is surely gone or surely older is replaced: one that cannot be read is left as it is.
      const saved = await fs.readFile(historyPath, 'utf8').then(
        (t) => ({ absent: false, file: JSON.parse(t) as unknown }),
        (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? { absent: true, file: null } : null)
      ).catch(() => null);
      const older = (f: unknown) => !!f && typeof f === 'object' && !Array.isArray(f) && Array.isArray((f as HistoryFile).entries) && olderFormat((f as HistoryFile).schemaVersion);
      if (saved && (saved.absent || older(saved.file))) await atomicWrite(historyPath, toJson(usableHistory(journal.history)));
    }
    if (Number.isInteger(journal.revision)) await this.writeRevision(journal.revision!);
    const finished = typeof journal.finishRun === 'string';
    if (finished) await removeDurable(marker);
    // The marker an edit saved into a waiting run's checkpoint leaves, checked above, before the journal goes: the run's
    // recovery after this restores the edit with the rest of the checkpoint.
    else if (runMarker) await atomicWrite(marker, toJson(runMarker));
    await removeDurable(this.local('journal.json'));
    this.recoveryNotes.push(
      conflicts
        ? `Finished an interrupted save. ${conflicts} file(s) had been changed outside the app and were kept as they are; choose which version to keep in Project health.`
        : finished && !journal.writes.length && !journal.deletes.length
          ? usableJournalHistory(journal.history)
            ? 'Finished saving an AI change that was interrupted. It can be undone in one step.'
            : 'Finished saving an AI change that was interrupted. It was saved before the app was updated, so it cannot be undone.'
          : `Finished an interrupted save (${journal.writes.length + journal.deletes.length} file(s)).`
    );
  }

  /**
   * Whether `m`, the marker an interrupted save carries (Journal.runMarker), may replace the marker on disk
   * (`markerText`). `fits`: one of the same run, naming only project documents, every file the marker on disk names
   * and every version it lists as the run's, each checkpoint version it names stored. `other`: the marker on disk is
   * another run's, or unreadable (run recovery discards that), so it is left alone. `unfit`: it cannot stand in for it.
   * A version that cannot be read for any other reason than being missing or damaged stops recovery, to be tried again.
   */
  private async markerFit(m: unknown, markerText: string): Promise<'fits' | 'other' | 'unfit'> {
    let onDisk: { id?: unknown; paths?: Record<string, { written?: unknown } | null> } | null;
    try {
      onDisk = JSON.parse(markerText);
    } catch {
      return 'other';
    }
    if (!onDisk || typeof onDisk !== 'object' || typeof onDisk.id !== 'string') return 'other';
    const marker = m as Partial<RunMarker> | null;
    const id = marker && typeof marker === 'object' ? marker.id : undefined;
    if (typeof id === 'string' && id !== onDisk.id) return 'other';
    if (typeof id !== 'string' || !marker!.paths || typeof marker!.paths !== 'object') return 'unfit';
    const paths = marker!.paths;
    const hash = (h: unknown) => h === null || (typeof h === 'string' && /^[a-f0-9]{64}$/.test(h));
    for (const [path, d] of Object.entries(paths)) if (!isCanonicalPath(path) || !d || typeof d !== 'object' || !hash(d.before) || !hash(d.after) || !Array.isArray(d.written) || !d.written.every(hash)) return 'unfit';
    // It covers all the run has done: a file the marker on disk names, and a version it lists as the run's, are in it too.
    for (const [path, d] of Object.entries(onDisk.paths && typeof onDisk.paths === 'object' ? onDisk.paths : {})) {
      const now = Object.hasOwn(paths, path) ? paths[path] : undefined;
      const had = Array.isArray(d?.written) ? (d.written as unknown[]) : [];
      if (!now || had.some((h) => !now.written.includes(h as string | null))) return 'unfit';
    }
    for (const d of Object.values(paths)) {
      if (d.before === null) continue;
      try {
        await this.getBlob(d.before);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as Error).message === 'A history blob is corrupted.') return 'unfit';
        throw e;
      }
    }
    return 'fits';
  }

  /**
   * An AI run without a completion marker is restored to its pre-run state. Only the files the run
   * changed are touched, and only when they still hold exactly what the run wrote.
   */
  private async recoverInterruptedRun() {
    const marker = await readIfExists(this.local('sessions', 'active-run.json'));
    if (!marker) return;
    let run: { id: string; paths: Record<string, { before: string | null; after: string | null; written?: Array<string | null> }>; deletedOutside?: unknown };
    try {
      run = JSON.parse(marker);
    } catch {
      await removeDurable(this.local('sessions', 'active-run.json'));
      return;
    }
    const conflicts: string[] = [];
    let restored = 0;
    for (const [path, d] of Object.entries(run.paths ?? {})) {
      if (!isCanonicalPath(path)) continue;
      const disk = await this.diskContent(path);
      const h = disk === null ? null : sha(disk);
      // Never written, or already restored. The run is being undone, so a version an interrupted save of
      // the run was holding no longer applies.
      if (h === d.before) {
        // An AI hold whose attempted version could not be listed under Saved copies yet stays until it is.
        if (await this.saveAttempt(path).then(() => true, () => false)) this.releaseConflict(path);
        continue;
      }
      const before = d.before === null ? null : await this.getBlob(d.before).catch(() => undefined);
      // A code component's definition and source are only ever published together (and a delete removes the source
      // first), so a definition missing beside its source was deleted outside the app. A source recovery is itself
      // holding for the user is not evidence of that: the save that held it may have removed the definition.
      // An interrupted save of the run that went on to delete the source records what it found in the marker.
      const source = h === null && COMPONENT_DOC_RE.test(path) ? await this.sourcePathOf(d.before) : null;
      const deletedOutside =
        (Array.isArray(run.deletedOutside) && run.deletedOutside.includes(path)) || (!!source && !this.pending.has(source) && (await this.diskContent(source)) !== null);
      // Any version the run itself wrote (an earlier batch, if it stopped between batches) is the run's to undo.
      // A hold saved by an earlier session is the user's pending choice: never decided for them here.
      const runWrote = !deletedOutside && !this.loadedHolds.has(path) && (h === d.after || (Array.isArray(d.written) && d.written.includes(h)));
      if (!runWrote || before === undefined) {
        conflicts.push(path);
        // The pre-run version is what the project is restored to, so it is the version held for the user.
        // The latest version the run recorded for it (stored before the marker named it) is shown beside it.
        if (before !== undefined) {
          this.holdConflict(path, before, 'Changed outside SiteOrigin Builder during an interrupted AI run.', { attempted: attemptAt(d.after) });
          await this.attemptContent(path);
        }
        continue;
      }
      if (before === null) await this.removeCanonical(path);
      else await atomicWrite(safeJoin(this.dir, path), before);
      this.releaseConflict(path);
      restored++;
    }
    await this.saveConflicts();
    if (conflicts.length) {
      this.recoveryNotes.push(`An interrupted AI change was only partly reverted: ${conflicts.length} file(s) were changed outside the app. Choose which version to keep in Project health.`);
    } else if (restored) {
      this.recoveryNotes.push('An AI change was interrupted before it finished. The project was restored to how it was before that request.');
    }
    // A file restored by an earlier, interrupted attempt may not have reached the disk for good yet.
    await this.syncFoldersOf(Object.keys(run.paths ?? {}).filter(isCanonicalPath));
    await removeDurable(this.local('sessions', 'active-run.json'));
  }

  /**
   * Flush the folders of these project files, and every folder above them up to the project, so changes already
   * made to them (by an attempt that stopped part way, perhaps creating the folders) survive a power loss.
   */
  private async syncFoldersOf(paths: string[]) {
    const dirs = new Set<string>();
    for (const p of paths) for (let d = dirname(safeJoin(this.dir, p)); d.startsWith(this.dir) && !dirs.has(d); d = dirname(d)) dirs.add(d);
    for (const dir of dirs) if (existsSync(dir)) await syncDir(dir);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  private async writeAllDocs() {
    this.docs = stateToDocs(this.state);
    // In the order they were always written, but for the pages and component definitions, which need nothing of each
    // other: the manifest, which says the folder holds a project, then the documents every page and component is
    // read with (the site, its tokens, its library and its theme's lock), one after another; then the pages and
    // components a few at a time, each as durably, into folders made first; then the rest one after another (each
    // collection's settings before its entries, a component's code after its definition).
    const docs = [...this.docs];
    const together = ([path]: [string, string]) => path.startsWith(`${DOC_DIR}/pages/`) || path.startsWith(`${DOC_DIR}/components/`);
    const first = docs.findIndex(together);
    const at = first < 0 ? docs.length : first;
    const batch = docs.slice(at).filter(together);
    const after = docs.slice(at).filter((d) => !together(d));
    for (const [path, content] of docs.slice(0, at)) await atomicWrite(safeJoin(this.dir, path), content);
    await ensureParents(this.dir, batch.map(([path]) => path));
    await eachAtMost(WRITES_AT_ONCE, batch, ([path, content]) => atomicWrite(safeJoin(this.dir, path), content));
    for (const [path, content] of after) await atomicWrite(safeJoin(this.dir, path), content);
  }

  /**
   * Persist a new canonical state, regenerate derived files and record history. `cursor` moves the undo position
   * instead of recording a new step (undo and redo). A save that fails is kept for the editor to show until a later one
   * succeeds; one stopped cleanly by a file saved outside the app is a conflict instead, which Project health lists.
   */
  private async persist(next: ProjectState, opts: PersistOptions): Promise<SessionEvent> {
    try {
      return await this.writeState(next, opts);
    } catch (e) {
      if (e instanceof GuardRefusal) throw e;
      if (!(e instanceof DiskConflictError) || this.unsettled) {
        // What became of it (#1435): nothing of it written; its documents in place, with only the rest of the save left
        // for reopening to finish; its journal on disk, which reopening finishes; or its journal never put in place (its
        // rename failed), so reopening finishes nothing of it, although nothing more is saved until then.
        const kind: WriteFailure = !this.unsettled ? 'failed' : this.state === next ? 'landed' : this.journalInPlace && this.journalOf(this.revision + 1) ? 'unfinished' : 'blocked';
        // The save indicator names the change reopening finishes, and so none that it does not.
        this.failedSave = kind === 'blocked' ? null : { label: opts.label, message: e instanceof Error && e.message ? e.message : String(e) };
        if (e && typeof e === 'object') this.writeFailures.set(e, kind);
        this.emit('save-failed');
      }
      throw e;
    }
  }

  private async writeState(next: ProjectState, opts: PersistOptions): Promise<SessionEvent> {
    this.journalInPlace = false;
    // Frozen now, as it will be once it is the project: generated and serialized as it will stay.
    frozen(next);
    // A state whose theme is not available here would be generated from the wrong pack.
    const pin = themePinProblem(next);
    if (pin) throw new Error(pin);
    // Generate first: a generator failure must not leave canonical documents half-published.
    const generatingClean = perf.span('session.generate', { variant: 'clean' });
    const clean = this.generate(next, false);
    generatingClean();
    const generatingDev = perf.span('session.generate', { variant: 'dev' });
    const generated = { clean, dev: this.generate(next, true) };
    generatingDev();
    // The documents the change rewrites, adds and removes: every document serialized, each compared with its last text.
    const finding = perf.span('session.changedDocs');
    const nextDocs = stateToDocs(next);
    const rewritten: Array<[string, string]> = [];
    for (const [path, content] of nextDocs) if (this.docs.get(path) !== content) rewritten.push([path, content]);
    const removed: Array<[string, string]> = [];
    for (const [path, prev] of this.docs) if (!nextDocs.has(path)) removed.push([path, prev]);
    finding({ docs: nextDocs.size, changed: rewritten.length + removed.length });
    const changed: Record<string, { before: string | null; after: string | null }> = {};
    const writes: Array<{ path: string; blob: string; content: string; before: string | null }> = [];
    const deletes: Array<{ path: string; before: string }> = [];
    // The versions this change's journal and History step name that are not stored yet: stored with the journal.
    const blobs = new Map<string, string>();
    const blobOf = (content: string) => {
      const h = sha(content);
      if (!blobs.has(h) && !existsSync(this.local('history', 'blobs', `${h}.json`))) blobs.set(h, content);
      return h;
    };
    for (const [path, content] of rewritten) {
      const prev = this.docs.get(path);
      changed[path] = { before: prev === undefined ? null : blobOf(prev), after: blobOf(content) };
      writes.push({ path, blob: changed[path].after!, content, before: changed[path].before });
    }
    for (const [path, prev] of removed) {
      changed[path] = { before: blobOf(prev), after: null };
      // A file already gone (#1540) is History's to put back, never the journal's to remove: a file put back there
      // before an interrupted save is finished is kept.
      if (!opts.absent?.has(path)) deletes.push({ path, before: changed[path].before! });
    }
    // An edit saved into a waiting run's checkpoint (#1281) is the author's step from that checkpoint: what the run
    // changed before it is the run's own, recorded when the run finishes, from the checkpoint the edit leaves.
    const run = opts.rebaseRun ? this.activeRun : null;
    if (opts.rebaseRun && !run) throw new Error('That AI request is no longer running.');
    const rebased = opts.rebaseRun ? stateToDocs(frozen(opts.rebaseRun)) : null;
    const step: HistoryEntry['docs'] = {};
    if (run && rebased)
      for (const path of new Set([...run.before.keys(), ...rebased.keys()])) {
        const b = run.before.get(path);
        const a = rebased.get(path);
        if (b !== a) step[path] = { before: b === undefined ? null : blobOf(b), after: a === undefined ? null : blobOf(a) };
      }
    // Authored sources go before the definitions that name them, so a component's definition is never missing
    // beside its source part way through a delete: recovery can then tell that from a definition deleted outside.
    // Entries go before their collection's settings for the same reason: an entry is never left without the collection
    // it belongs to, which reading the project would refuse.
    // A source's converter goes before its settings, which name it.
    const deleteRank = (p: string) => (CUSTOM_SOURCE_RE.test(p) || converterPathOf(p) !== null ? 0 : collectionPathOf(p)?.entryId !== undefined ? 1 : 2);
    deletes.sort((a, b) => deleteRank(a.path) - deleteRank(b.path));
    // A change worked out from the whole project (a theme update or switch, a format update) also depends on files it
    // does not write: what builds on a component, what its placements hold. One changed outside the app since it was
    // read (an edit the watcher has not delivered yet) makes those checks stale, so the change waits for it. The
    // manifest says nothing they read, and the watcher does not see it change. The files it writes are checked after
    // this, last, so an edit to one of them while this reads is still caught.
    if (opts.wholeProject) {
      // Files held in conflict are SiteOrigin Builder's version until settled, whatever is on disk.
      const unloaded = await this.unloadedEdit(new Set([...Object.keys(changed), MANIFEST, ...this.pending.keys(), ...(opts.absent ?? [])]));
      if (unloaded) throw new DiskConflictError(unloaded);
    }
    // A change to an entry is allowed by its collection's settings, which it may not write (a synced collection's
    // entries are read-only): one changed outside the app since it was read makes the change wait for it.
    const settings = new Set(Object.keys(changed).flatMap((p) => (collectionPathOf(p)?.entryId !== undefined ? [collectionDocPath(collectionPathOf(p)!.collectionId)] : [])));
    for (const path of settings) if (!Object.hasOwn(changed, path) && !sameContent(path, await this.diskContent(path), this.docs.get(path) ?? null)) throw new DiskConflictError(path);
    // Never overwrite a newer version on disk (for example an edit the file watcher has not delivered yet). A file
    // that already holds exactly what this change leaves there (a source kept when its definition was deleted
    // outside the app, say) is not overwritten by it.
    const unchangedOnDisk = async (path: string) => {
      const disk = await this.diskContent(path);
      // Still gone, and nothing else: a file back there (even as it was) is never removed with the component.
      if (opts.absent?.has(path)) {
        if (disk === null && !nextDocs.has(path)) return true;
        throw new DiskConflictError(path);
      }
      const target = nextDocs.get(path);
      const already = !this.activeRun && target !== undefined && disk !== null && sameContent(path, disk, target);
      if (!sameContent(path, disk, this.docs.get(path) ?? null) && !already) throw new DiskConflictError(path);
      return true;
    };
    for (const path of Object.keys(changed)) await unchangedOnDisk(path);
    // An AI run's marker names the version it is leaving each file at, which is stored before the marker names it.
    if (this.activeRun) {
      await this.storeBlobs(blobs);
      blobs.clear();
      // The marker an edit saved into the checkpoint leaves goes with its journal instead: until that is on disk, a crash
      // restores the checkpoint without it, and the files without it are still the run's own.
      if (!rebased) await this.writeRunMarker(nextDocs);
    }
    const rebasedMarker = run && rebased ? await this.runMarker(rebased, nextDocs) : undefined;
    const runMarker = rebasedMarker?.marker;
    // The undo position is part of the change: planned now, journaled with the documents, installed with them. A change
    // folded into History (amendHistory) is journaled with the History it leaves too.
    const planned = rebased
      ? Object.keys(step).length
        ? this.planHistory(step, opts, this.revision + 1)
        : null
      : opts.history !== false && Object.keys(changed).length
        ? this.planHistory(changed, opts, this.revision + 1)
        : opts.cursor !== undefined
          ? { history: { ...this.history, cursor: opts.cursor }, pruned: false, entryId: undefined }
          : opts.amendHistory && Object.keys(changed).length
            ? { history: amendedHistory(this.history, changed), pruned: false, entryId: undefined }
            : null;
    const journaled = !!(writes.length || deletes.length || planned);
    // A guard (CommitOptions.guard) is asked now, and again as the journal is about to take its place: the last moment
    // the change can be turned away whole, with nothing of it on disk but its blobs.
    const guard = opts.guard;
    const stillAllowed = () => {
      const refused = guard?.(next);
      if (refused) throw new GuardRefusal(refused);
      return true;
    };
    stillAllowed();
    let changedFiles: string[];
    // Files replaced or removed so far: a change stopped before the first one has changed nothing on disk.
    let installed = 0;
    // The documents, History and revision of this change, written and flushed beside their paths before they replace them.
    let staged: StagedWrite[] = [];
    // Whether this change's journal may be on disk: from the moment it is about to take its place.
    let journalPlaced = false;
    let event!: SessionEvent;
    // What a listener of the announcement threw, raised once the save is done, as it was when the save announced last.
    let unheard: { error: unknown } | null = null;
    try {
      // Journal first, then replace files. Each durable file is written and flushed beside its path, several at once,
      // before any takes its place, so their flushes overlap; a folder is flushed once for all the files renamed in it.
      // A batch with many or large new versions (a sync of a whole collection) stores them first, as a smaller journal
      // is quicker to write than they are; it carries the rest.
      if (blobs.size > CARRIED_VERSIONS || [...blobs.values()].reduce((n, c) => n + c.length, 0) > CARRIED_BYTES) {
        await this.storeBlobs(blobs);
        blobs.clear();
      }
      if (journaled)
        await this.placeJournal(
          { writes: writes.map(({ path, blob, before }) => ({ path, blob, before })), deletes, history: planned?.history, revision: this.revision + 1, ...(runMarker ? { runMarker } : {}), ...(blobs.size ? { versions: Object.fromEntries(blobs) } : {}) },
          async () => {
            journalPlaced = true;
            return stillAllowed();
          }
        );
      try {
        // A code component's source the preview watches is replaced with the files generated from it, in one update.
        changedFiles = await this.publishing(async () => {
          // The documents, flushed together once the journal that can finish them is on disk.
          staged = await stageWrites(writes.map((w) => ({ path: safeJoin(this.dir, w.path), data: w.content })));
          // Each file is checked again just before it is replaced or removed: one saved outside the app since the check
          // above (while the journal was being written) is never replaced unseen.
          for (const [i, w] of writes.entries()) {
            await staged[i].replace(() => unchangedOnDisk(w.path));
            this.landing?.add(w.path);
            installed++;
          }
          // Still gone, checked again just before the documents that named it are removed.
          for (const path of opts.absent ?? []) if (Object.hasOwn(changed, path)) await unchangedOnDisk(path);
          for (const d of deletes) {
            await unchangedOnDisk(d.path);
            await this.removeCanonical(d.path);
            this.landing?.add(d.path);
            installed++;
          }
          // The documents, their undo position and the revision change together, before the generated files are
          // written: a snapshot taken while those land (which can take a second on Windows) never shows the new
          // documents beside the History and revision of the step before, which would show one step too few to undo.
          this.carryChecks(this.state, next, Object.keys(changed));
          this.state = next;
          this.docs = nextDocs;
          for (const w of writes) this.absentSources.delete(w.path);
          // The run's checkpoint holds the edit from now on, as its marker will once the journal is done.
          if (run && rebased && rebasedMarker) {
            run.before = rebased;
            run.beforeState = opts.rebaseRun!;
            run.written = rebasedMarker.written;
          }
          if (planned) this.history = planned.history;
          this.revision++;
          return this.publishGenerated(false, generated);
        });
        const files = changedFiles;
        const announce = () => {
          // This save reached the disk, so an earlier one that failed no longer describes the project.
          this.failedSave = null;
          event = { revision: this.revision, changedDocs: Object.keys(changed), changedFiles: files, label: opts.label, source: opts.source ?? 'user', entryId: planned?.entryId };
          perf.mark('session.changed', { revision: this.revision, docs: event.changedDocs.length, files: files.length });
          try {
            this.emit('changed', event);
          } catch (error) {
            unheard = { error };
          }
        };
        // A journaled change is committed now: its journal is on disk, so a crash from here on finishes it, and its
        // documents and the preview's files are in place. It is announced at once, so the editor need not wait for its
        // versions, History and revision to take their places and the journal to go; a failure to finish them still
        // says the project must be reopened. One with no journal has only its revision to record, so that comes first.
        if (journaled) announce();
        await this.finishSave(staged, [
          ...this.blobWrites(blobs),
          ...(planned ? [{ path: this.local('history', 'history.json'), data: toJson(planned.history) }] : []),
          ...(runMarker ? [{ path: this.local('sessions', 'active-run.json'), data: toJson(runMarker) }] : []),
          { path: this.local('state.json'), data: toJson({ revision: this.revision }) }
        ]);
        if (!journaled) announce();
      } finally {
        await Promise.all(staged.map((f) => f.discard()));
      }
      if (journaled) await removeDurable(this.local('journal.json'));
    } catch (e) {
      // Turned away by its guard before its journal took its place: nothing of it reached the project.
      if (e instanceof GuardRefusal) throw e;
      // Stopped by a file saved outside the app before anything was replaced: nothing of this change is on disk, so
      // its journal goes and the project carries on (an AI request's own recovery marker is left to its rollback). An
      // edit saved into a run's checkpoint left the run's marker as it was, so that goes on too.
      if (journaled && installed === 0 && (!this.activeRun || !!runMarker) && e instanceof DiskConflictError) {
        const cleared = await removeDurable(this.local('journal.json')).then(
          () => true,
          () => false
        );
        if (cleared) throw e;
      }
      // The journal on disk may now describe this change; a later save would replace it. Reopening finishes it. One
      // stopped before its journal could take its place left only versions no journal names: nothing to finish.
      if (journalPlaced) this.unsettled = true;
      throw e;
    }
    if (planned && (planned.pruned || --this.gcCountdown <= 0)) this.sweepSoon();
    // Set inside `announce`, which the compiler cannot follow.
    const listener = unheard as { error: unknown } | null;
    if (listener) throw listener.error;
    return event;
  }

  /**
   * Put a change's journal in place for good: flushed, renamed, its folder flushed. It carries the versions it names
   * that are not stored yet (`versions`), so nothing else need reach the disk before it. `beforeReplace` is asked as
   * the journal is about to take its place.
   */
  private async placeJournal(j: Omit<Journal, 'schemaVersion'>, beforeReplace: () => Promise<boolean>) {
    const [journal] = await stageWrites([{ path: this.local('journal.json'), data: toJson({ schemaVersion: SCHEMA_VERSION, ...j } satisfies Journal) }]);
    try {
      if (await journal.replace(beforeReplace)) this.journalInPlace = true;
      await syncStaged([journal]);
    } finally {
      await journal.discard();
    }
  }

  /**
   * The end of a save, once the preview has its update: the versions its journal carries, the History that names them
   * and the revision (`files`, flushed together) take their places after the documents (`documents`, in place already),
   * then every folder a file of the save was renamed in is flushed, together, before its journal goes.
   */
  private async finishSave(documents: StagedWrite[], files: Array<{ path: string; data: string }>) {
    const staged = await stageWrites(files);
    try {
      for (const f of staged) await f.replace();
      await syncStaged([...documents, ...staged]);
    } finally {
      await Promise.all(staged.map((f) => f.discard()));
    }
  }

  private async writeJournal(j: Omit<Journal, 'schemaVersion'>, beforeReplace?: () => Promise<boolean>): Promise<boolean> {
    // Asked again before each Windows rename retry too: the journal is the run's decision, and what decided it must hold.
    return atomicWrite(this.local('journal.json'), toJson({ schemaVersion: SCHEMA_VERSION, ...j } satisfies Journal), beforeReplace ? { beforeReplace, retryCheck: beforeReplace } : {});
  }

  /**
   * Whether code in `state` finds a file of the project at `path` (CheckOptions.modules): a code component's source,
   * a file of the project's own on disk (never a folder) that the app never wrote nor holds a component's code in, or a file the app writes for
   * `writes` (the runtime helpers, the designs' files, the theme's font copies). A file the app wrote before is there
   * only while it still writes it, whatever is on disk now. The app's files are made only when an import reaches
   * past the others, once per resolver and state, unless `files` already holds them.
   */
  projectModules(state: ProjectState, files?: Map<string, string>, writes: ProjectState = state): (path: string) => boolean {
    const sources = componentSources(state.components);
    const saved = componentSources(this.state.components);
    let made: Set<string> | null | undefined = files ? new Set([...files.keys(), ...packFileCopies(writes, this.generation).map((c) => c.path)]) : undefined;
    return (path) => {
      if (sources(path) !== undefined) return true;
      // A code component's file is the app's too: it goes with the component.
      if (!Object.hasOwn(this.generated.files, path) && saved(path) === undefined) {
        try {
          if (statSync(safeJoin(this.dir, path)).isFile()) return true;
        } catch {
          // Not a file of the project's own: the app may still write one there.
        }
      }
      made ??= this.writtenFiles(writes);
      // A project that cannot be generated is refused by its save, which says why; no import is blamed for it.
      return made === null || made.has(path);
    };
  }

  /** The files the app writes for `state`, or null when it cannot be generated; kept per state, as states never change. */
  private writtenFiles(state: ProjectState): Set<string> | null {
    const known = this.written.get(state);
    if (known !== undefined) return known;
    let files: Set<string> | null;
    try {
      files = new Set([...this.generate(state, false).keys(), ...packFileCopies(state, this.generation).map((c) => c.path)]);
    } catch {
      files = null;
    }
    this.written.set(state, files);
    return files;
  }

  /**
   * projectModules for code being edited and not yet saved (the code editor's check, as it types): the project as it
   * is, with the draft as the code of the component it edits. What the app writes is read from the project as it is
   * (made once per saved state), and only for an import that finds nothing there, from the project with the draft in
   * it: what the app writes can hang on the code itself (the search helper is written once a component searches).
   * A new component's draft stands in under a name of its own, which no import may find.
   */
  draftModules(source: string, definitionId?: string): (path: string) => boolean {
    const was = definitionId !== undefined && Object.hasOwn(this.state.components, definitionId) ? this.state.components[definitionId] : undefined;
    const own = was?.kind === 'code';
    const stand = `${CUSTOM_DIR}/.draft-check.svelte`;
    const def: ComponentDefinition = own ? { ...was!, source } : { schemaVersion: SCHEMA_VERSION, id: 'code.draft-check', componentId: 'project.draft-check', contractVersion: 1, kind: 'code', owner: 'project', name: 'Draft', description: '', category: 'custom', tags: [], properties: {}, parts: { root: { nodeId: 'root', label: 'Root' } }, source, sourcePath: stand };
    const draft: ProjectState = { ...this.state, components: { ...this.state.components, [def.id]: def } };
    const base = own ? draft : this.state;
    const now = this.projectModules(base, undefined, this.state);
    let drafted: ((path: string) => boolean) | undefined;
    return (path) => now(path) || (path !== stand && (drafted ??= this.projectModules(base, undefined, draft))(path));
  }

  /** Every generated file for `state`, reusing what earlier generations made from inputs that are unchanged. */
  private generate(state: ProjectState, instrument: boolean): Map<string, string> {
    const files = generateProject(state, { instrument }, this.generation);
    // How long the generation cache spent finding which files' inputs are unchanged (src/generator/cache.ts).
    if (perf.on) perf.mark('session.generateCheck', { variant: instrument ? 'dev' : 'clean', ms: this.generation.checkMs, files: this.generation.checked, looked: this.generation.looked, derived: this.generation.derived });
    return files;
  }

  /**
   * The website's files for the project as it is now (the clean variant, which the build checks compile), made through
   * the generation cache every save and publication shares: only what changed since the last generation is made again.
   */
  websiteFiles(): Map<string, string> {
    return this.generate(this.state, false);
  }

  /** `generate`, timed as a save's generations are (writeState), for a publication that generates its own. */
  private generateTimed(state: ProjectState, instrument: boolean): Map<string, string> {
    const generating = perf.span('session.generate', { variant: instrument ? 'dev' : 'clean' });
    const files = this.generate(state, instrument);
    generating();
    return files;
  }

  /**
   * The hash a generated file's bytes had when last read, while its stat is still what it was then: looking costs a
   * stat, never a read, and nothing when the path's containment check just saw the file (`looked`, from
   * safeJoinLooking). Undefined when the file has to be read to be known.
   */
  private async seenHash(abs: string, looked?: Looked): Promise<string | undefined> {
    const seen = this.seenOnDisk.get(abs);
    if (!seen) return undefined;
    let st = looked;
    if (st === undefined) {
      perf.count('files.stats');
      st = await fs.stat(abs, { bigint: true }).catch(() => null);
    }
    return st && stampOf(st) === seen.stamp ? seen.hash : undefined;
  }

  /**
   * What is at a generated file's path now: the SHA-256 of its bytes, null when nothing is there, or UNREADABLE when
   * something is there that cannot be read as it is (no access, a folder or pipe, a file swapped under every read),
   * which is someone else's and never passes for missing. `stamp` is the path's stat the hash belongs to, so a
   * decision made on it can be checked again just before it is acted on. Stats are only ever compared with stats
   * taken the same way (path with path, handle with handle), since the two can differ in form on some systems.
   * Remembered by its stat when it can stand for its bytes.
   */
  private async readHash(abs: string, keep?: (bytes: Buffer) => void): Promise<{ hash: string | null; stamp: string | null }> {
    this.seenOnDisk.delete(abs);
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = Date.now();
      const before = await lookAt(abs);
      if (before === 'missing') return { hash: null, stamp: null };
      if (before === 'failed') return { hash: UNREADABLE, stamp: null };
      const read = await readFileAt(abs);
      if (read === 'failed') return { hash: UNREADABLE, stamp: null };
      if (read === 'missing' || read === 'changed') continue;
      // The path still reaches the file that was read, and its stat did not change meanwhile. Where a path's stat and a
      // handle's are taken the same way (everywhere but Windows), they must name the same file too.
      const after = await lookAt(abs);
      if ((await handleStamp(abs)) !== read.stamp || typeof after === 'string' || stampOf(after) !== stampOf(before)) continue;
      if (process.platform !== 'win32' && stampOf(before) !== read.stamp) continue;
      const hash = sha(read.bytes);
      perf.count('files.hashed');
      perf.count('files.hashedBytes', read.bytes.length);
      const stamp = stampOf(before);
      if (statTrusted(before, started, this.settleMs)) this.seenOnDisk.set(abs, { stamp, hash });
      keep?.(read.bytes);
      return { hash, stamp };
    }
    // Changing under every read: someone else is writing it.
    return { hash: UNREADABLE, stamp: null };
  }

  /**
   * Run `fn`, which replaces files the preview shows, with the preview's hot updates held, so it takes what `fn`
   * changes (each noted in `landing`) as one update once `fn` is done. Inside another such run, `fn` is part of it.
   */
  private async publishing<T>(fn: () => Promise<T>): Promise<T> {
    if (this.landing || !this.previewHold) return fn();
    const landing = new Set<string>();
    this.landing = landing;
    let release: ((files: string[]) => void) | null = null;
    try {
      release = await this.previewHold().catch(() => null);
      return await fn();
    } finally {
      if (this.landing === landing) this.landing = null;
      // Also after a publication that stopped part way: the preview then shows what is on disk, as reopening would.
      release?.([...landing]);
    }
  }

  /** Regenerate derived files. Files edited externally since the last generation are preserved and reported. */
  private publishGenerated(initial: boolean, pre?: { clean: Map<string, string>; dev: Map<string, string> }): Promise<string[]> {
    return this.publishing(timed('session.publish', () => this.publishGeneratedNow(initial, pre), (files) => ({ initial, changed: files?.length ?? null })));
  }

  private async publishGeneratedNow(initial: boolean, pre?: { clean: Map<string, string>; dev: Map<string, string> }): Promise<string[]> {
    // The website's icons are drawn in the media worker while this generates and checks the files (on opening, when
    // none are kept yet, that takes as long as everything else here); they are waited for below, as before.
    if (!pre) await this.siteIcons.prepare(this.dir, this.state, await this.recallSiteIcons());
    const clean = new Map(pre?.clean ?? this.generateTimed(this.state, false));
    const dev = new Map(pre?.dev ?? this.generateTimed(this.state, true));
    const devRoot = this.local('cache', 'dev');
    const changedFiles: string[] = [];
    const prev = this.generated.files;
    const inflight = this.generated.pending ?? {};
    const known = (path: string) => !!prev[path] || !!inflight[path];
    // SvelteKit runs one server hook: a project with its own keeps it, and the generated one is left out. The site's
    // server hook is still written to the library, for the project's own to run (see generateServerHook); one that
    // does not leaves the not-found page with the addresses it was built with, and pages without their languages, which
    // the export of the website says.
    if (ownServerHook(this.dir, known(SERVER_HOOK_FILE))) for (const files of [clean, dev]) files.delete(SERVER_HOOK_FILE);
    const ours = (path: string, hash: string | null) => hash !== null && (hash === prev[path] || hash === inflight[path]);
    const nextFiles: Record<string, string> = {};
    const authored = new Set(stateToAuthoredSources(this.state).keys());
    const hashes = new Map<string, { content: string | Buffer; hash: string }>();
    const hashOf = (abs: string, content: string | Buffer) => {
      const was = this.contentHashes.get(abs);
      const cached = !!was && was.content === content;
      const hash = cached ? was!.hash : sha(content);
      if (!cached) {
        perf.count('files.hashed');
        if (perf.on) perf.count('files.hashedBytes', typeof content === 'string' ? Buffer.byteLength(content) : content.length);
      }
      hashes.set(abs, { content, hash });
      return hash;
    };
    this.conflicts = this.conflicts.filter((c) => c.kind !== 'generated');
    /** Files this app wrote that were edited outside it: a design's own may become a code component (see below). */
    const edited = new Set<string>();
    // The publication's stretches, one after another, for the benchmark's traces.
    let stretch = perf.span('session.publish.copies');
    const next = (name: string, attrs?: Parameters<typeof perf.span>[1]) => {
      stretch();
      stretch = perf.span(name, attrs);
    };
    // The theme's font files are copied from its pack beside the generated text, under the same ownership rules.
    const copies = new Map<string, string | Buffer>();
    const fonts = packFileCopies(this.state, this.generation).filter((c) => !authored.has(c.path) && !clean.has(c.path));
    /** Copies taken from the pack's bytes the last publication held rather than read from the pack now (see below). */
    const held = new Map<string, PackFileCopy>();
    /** A pack that cannot supply a copy costs that font's update, not the save. */
    const uncopied = async (c: PackFileCopy, e: unknown) => {
      // A copy already in the project stays, still claimed, so it is neither replaced nor removed as obsolete.
      console.warn(`Not copying ${c.path}: ${(e as Error).message}`);
      // Only a copy that already is the pack's validated file is kept: another theme's file of the same name is not.
      // A copy that cannot be read stays claimed, so it is never removed and a missing one is still noticed.
      if (!known(c.path)) return;
      // Checked again on its own: the pack was being read meanwhile.
      const disk = await readBytesIfExists(safeJoin(this.dir, c.path));
      const h = disk === null ? null : sha(disk);
      if (h === null) nextFiles[c.path] = prev[c.path] ?? inflight[c.path];
      else if (ours(c.path, h) && h === packFileInfo(c.pack, c.file)?.sha256) nextFiles[c.path] = h;
    };
    for (const c of fonts) {
      // Published last time from bytes that hash to what the pack lists for it now: the pack's validated bytes, held
      // since. While the copy on disk is still those bytes (found below), the pack is not read, nor its bytes hashed,
      // again; a copy that is anything else is decided only once the pack has been read and checked, as ever.
      // Named as the check below names it (safeJoinLooking): `resolve` is what it comes to for any path it accepts.
      const was = this.contentHashes.get(resolvePath(this.dir, c.path));
      if (was && was.hash === packFileInfo(c.pack, c.file)?.sha256) {
        copies.set(c.path, was.content);
        held.set(c.path, c);
        continue;
      }
      try {
        copies.set(c.path, await readPackFile(c.pack, c.file));
      } catch (e) {
        await uncopied(c, e);
      }
    }
    // The website's icons are drawn from the favicon (or the monogram) beside the generated text, under the same rules.
    // A set that cannot be made now costs the icons' update, not the save: icons already claimed stay, still claimed,
    // so they are neither replaced nor removed as obsolete. A file of someone else's at an icon's path is still named.
    next('session.publish.icons');
    const icons = await this.siteIcons.make(this.dir, this.state);
    this.iconsAsked = icons.key;
    for (const path of SITE_ICON_PATHS) {
      if (authored.has(path) || clean.has(path)) continue;
      const made = icons.files?.get(path);
      if (made) {
        copies.set(path, made);
        continue;
      }
      // A file there that this app never wrote is someone else's, whatever it holds: named, never read.
      const abs = safeJoin(this.dir, path);
      if (!known(path)) {
        // Anything there but nothing at all, including what cannot be looked at, counts as there.
        perf.count('files.stats');
        const there = await fs.lstat(abs).then(
          () => true,
          (e: NodeJS.ErrnoException) => e.code !== 'ENOENT'
        );
        if (!initial && there) this.conflicts.push({ path, reason: 'Generated file would replace a file that SiteOrigin Builder did not create. Move or delete that file, then restore.', kind: 'generated' });
        continue;
      }
      // One of this app's is kept as it is: claimed as whichever of its own versions is there (a publication that
      // stopped part way may have left the newer one), named when it is neither, and still claimed when it has gone.
      const { hash } = await this.readHash(abs);
      if (hash !== null && ours(path, hash)) nextFiles[path] = hash;
      else {
        nextFiles[path] = prev[path] ?? inflight[path];
        if (hash !== null) this.conflicts.push({ path, reason: hash === UNREADABLE ? UNREADABLE_REASON : 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.', kind: 'generated' });
      }
    }
    next('session.publish.check');
    // Looked at together, in one pass that checks each folder on the way once: a file unchanged on disk since it was
    // last read is not read again. A file is checked again, on its own, just before it is replaced or removed.
    const projectFiles = [...copies, ...clean].filter(([path]) => !authored.has(path));
    const projectPass = new FolderPass();
    const project = projectFiles.map(([path, content]) => ({ path, content, ...safeJoinLooking(this.dir, path, projectPass) }));
    const seen = await inBatches(project, (f) => this.seenHash(f.abs, f.st));
    // Decide first which project files are someone else's now, so no editor variant shadows them in the preview.
    const plan: Array<{ path: string; content: string | Buffer; hash: string; stamp: string | null }> = [];
    const desired: Record<string, string> = {};
    // Generated the same as last time, and still the bytes it was then: nothing to decide.
    const wanted = project.map(({ abs, content }, i) => {
      const was = this.contentHashes.get(abs)?.hash;
      const h = hashOf(abs, content);
      return { h, settled: seen[i] === h && was === h };
    });
    // Any other is replaced, kept as someone else's, or found already right: decided on its bytes as they are now,
    // read a few at a time. A replacement looks at the file again just before it takes its path (`replace`, below).
    const onDisk = await inBatches(
      project.map((f, i) => ({ abs: f.abs, settled: wanted[i].settled })),
      (f) => (f.settled ? null : this.readHash(f.abs))
    );
    for (const [i, { path, content, abs }] of project.entries()) {
      const { h, settled } = wanted[i];
      desired[path] = h;
      nextFiles[path] = h;
      if (settled) continue;
      const { hash: diskHash, stamp } = onDisk[i]!;
      if (diskHash === h) continue;
      // A copy taken from the pack's held bytes that is not those bytes on disk (gone, or someone else's): the pack is
      // read and checked first, and one that cannot supply it now leaves the copy as a failed read of it would.
      const copy = held.get(path);
      if (copy) {
        const failed = await readPackFile(copy.pack, copy.file).then(
          () => null,
          (e: unknown) => ({ e })
        );
        if (failed) {
          delete desired[path];
          delete nextFiles[path];
          hashes.delete(abs);
          await uncopied(copy, failed.e);
          continue;
        }
      }
      if (!initial && diskHash !== null && known(path) && !ours(path, diskHash)) {
        // Edited outside the app (or no longer readable by it): keep the external version.
        nextFiles[path] = prev[path] ?? inflight[path];
        this.conflicts.push({ path, reason: diskHash === UNREADABLE ? UNREADABLE_REASON : 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.', kind: 'generated' });
        if (diskHash !== UNREADABLE) edited.add(path);
        continue;
      }
      if (!initial && diskHash !== null && !known(path)) {
        // A file we never wrote already lives here: never overwrite someone's own work.
        delete nextFiles[path];
        this.conflicts.push({ path, reason: 'Generated file would replace a file that SiteOrigin Builder did not create. Move or delete that file, then restore.', kind: 'generated' });
        continue;
      }
      plan.push({ path, content, hash: h, stamp });
    }
    next('session.publish.variants');
    const keptExternal = new Set(this.conflicts.filter((c) => c.kind === 'generated').map((c) => c.path));
    // Dev variants (with editor identity attributes, never part of the portable source) are written before the
    // project files, so the dev server never loads a stale instrumented file. A file kept as edited outside the
    // app has no variant: the preview shows the external version, as the exported site would.
    // Looked at together as the project's files are, each checked again on its own before it is written or removed.
    const variantFiles = [...dev].filter(([path]) => !authored.has(path));
    const variantPass = new FolderPass();
    const variants = variantFiles.map(([path, content]) => ({ path, content, ...safeJoinLooking(devRoot, path, variantPass) }));
    // A variant that cannot be read is written again: only the app writes them.
    const variantsOnDisk = await inBatches(variants, async (f) => (keptExternal.has(f.path) ? null : ((await this.seenHash(f.abs, f.st)) ?? (await this.readHash(f.abs)).hash)));
    /** Project files whose variant this publication changed (an empty Grid arranged as a Row is named a Row there only). */
    const variantsChanged = new Set<string>();
    for (const [i, { path, content, abs }] of variants.entries()) {
      if (keptExternal.has(path)) {
        const variant = safeJoin(devRoot, path);
        perf.count('fs.syncCalls');
        if (existsSync(variant)) {
          await fs.rm(variant, { force: true });
          this.seenOnDisk.delete(abs);
          // The preview may have cached the variant; touching the real file makes it load that file instead.
          const now = new Date();
          if (await fs.utimes(safeJoin(this.dir, path), now, now).then(() => true, () => false)) this.landing?.add(path);
        }
        continue;
      }
      // Rebuilt from the documents on every publication, so a power loss costs nothing here.
      const hash = hashOf(abs, content);
      if (variantsOnDisk[i] !== hash) {
        variantsChanged.add(path);
        this.seenOnDisk.delete(abs);
        await atomicWrite(safeJoin(devRoot, path), content, { durable: false });
        // Only the app writes its preview variants, so the file now on disk is this one.
        perf.count('files.stats');
        const st = await fs.stat(abs, { bigint: true }).catch(() => null);
        if (st) this.seenOnDisk.set(abs, { stamp: stampOf(st), hash });
      }
    }
    // The preview serves a variant only while the project file is the one generated here; written before the
    // project files, so a file mid-publication is never mistaken for an edit made outside the app.
    await atomicWrite(join(devRoot, CLEAN_HASHES), JSON.stringify(desired), { durable: false });
    next('session.publish.write', { files: plan.length });
    // Claimed before they are written: a publication that stops part way (a crash, an AI run being rolled back)
    // leaves files the next one recognises as its own, to replace or remove, never as someone else's.
    if (plan.length) await this.writeManifest(prev, { ...inflight, ...Object.fromEntries(plan.map((f) => [f.path, f.hash])) });
    if (initial) {
      // A new project's first publication, into the folder it was made in: nothing of anyone's can be in the way and
      // no preview watches it, so its files are written a few at a time, each as durably, into folders made first.
      for (const f of plan) this.seenOnDisk.delete(safeJoin(this.dir, f.path));
      await ensureParents(this.dir, plan.map((f) => f.path));
      await eachAtMost(WRITES_AT_ONCE, plan, (f) => atomicWrite(safeJoin(this.dir, f.path), f.content));
      for (const f of plan) {
        changedFiles.push(f.path);
        this.landing?.add(f.path);
      }
    }
    for (const { path, content, hash: h, stamp } of initial ? [] : plan) {
      // Checked again on its own, just before it is replaced: the pass that found it changed only looked.
      const abs = safeJoin(this.dir, path);
      this.seenOnDisk.delete(abs);
      let theirs = false;
      // Checked again once the new file is ready, just before it takes the path: a file that changed since it was
      // looked at (saved by an editor meanwhile, say) is decided again on what is there now.
      const replace = async () => {
        // And once more as the new file is about to take its path: a folder swapped for a link while it was being
        // written is refused, never written through.
        safeJoin(this.dir, path);
        if (initial) return true;
        const now = await lookAt(abs);
        if ((now === 'missing' ? null : now === 'failed' ? UNREADABLE : stampOf(now)) === stamp) return true;
        const { hash: there } = await this.readHash(abs);
        if (there === h) return false;
        // Nothing readable there may still be something: a link to nowhere is someone else's too.
        if (there === null) {
          perf.count('files.stats');
          if (!(await fs.lstat(abs).catch(() => null))) return true;
        }
        if (there !== null && ours(path, there)) return true;
        theirs = true;
        return false;
      };
      let written = false;
      try {
        written = await atomicWrite(abs, content, { beforeReplace: replace });
      } catch (e) {
        // A folder on the way that is now a file: what is in the way is someone else's, never a reason to stop.
        if (initial || !['ENOTDIR', 'EEXIST'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
        theirs = true;
      }
      if (written) {
        changedFiles.push(path);
        this.landing?.add(path);
      } else if (theirs) {
        if (known(path)) {
          nextFiles[path] = prev[path] ?? inflight[path];
          edited.add(path);
        } else delete nextFiles[path];
        this.conflicts.push({ path, reason: 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.', kind: 'generated' });
        const variant = safeJoin(devRoot, path);
        await fs.rm(variant, { force: true });
        this.seenOnDisk.delete(variant);
      }
    }
    next('session.publish.finish');
    // The preview does not watch the editor's cache: a project file whose variant alone changed is touched, so the
    // preview loads the new variant (as a read-only project's private copy does, see syncPreviewStage). Only a file
    // that is this app's own as it stands, and only once the preview may be running.
    // A file that could not be touched is tried again at the next publication; one written meanwhile needs none.
    if (!initial) {
      const now = new Date();
      for (const path of new Set([...variantsChanged, ...this.untouched])) {
        this.untouched.delete(path);
        if (!(path in nextFiles) || changedFiles.includes(path) || keptExternal.has(path) || this.conflicts.some((c) => c.path === path)) continue;
        // Never a reason for the save to fail: the path checked again (it may lead elsewhere now), the file read, the stamp set.
        try {
          const abs = safeJoin(this.dir, path);
          if ((await this.seenHash(abs)) !== nextFiles[path] && (await this.readHash(abs)).hash !== nextFiles[path]) continue;
          this.seenOnDisk.delete(abs);
          await fs.utimes(abs, now, now);
          this.landing?.add(path);
        } catch {
          this.untouched.add(path);
        }
      }
    }
    // Remove files that are no longer generated, for good before the manifest stops claiming them.
    for (const path of new Set([...Object.keys(prev), ...Object.keys(inflight)])) {
      if (path in nextFiles) continue;
      const abs = safeJoin(this.dir, path);
      const variant = safeJoin(devRoot, path);
      await fs.rm(variant, { force: true });
      this.seenOnDisk.delete(variant);
      // Read just before it goes, so a save made meanwhile is never removed.
      const { hash: diskHash } = await this.readHash(abs);
      // An obsolete file that was edited outside the app is left alone and no longer owned.
      if (ours(path, diskHash)) {
        this.seenOnDisk.delete(abs);
        await removeDurable(abs);
        this.landing?.add(path);
        await removeEmptyDirs(dirname(abs), join(this.dir, 'src'));
        changedFiles.push(path);
      } else if (diskHash !== null && claimedWhenObsolete(path) && (await fs.lstat(abs).then((st) => st.isFile(), () => false))) {
        // A file for AI agents or feed readers edited outside the app that the website no longer has (its page made a
        // draft or hidden from search engines, its copy turned off, its last post unpublished) would still publish its
        // words: it stays claimed, so neither export carries it unnoticed, and named, until it is restored (removed)
        // or moved away.
        nextFiles[path] = prev[path] ?? inflight[path];
        // So would redirect rules a host follows, even past a page given one of their addresses since.
        this.conflicts.push({ path, reason: path === RSS_PATH ? OBSOLETE_FEED_REASON : routesVisitors(path) ? OBSOLETE_REDIRECTS_REASON : OBSOLETE_DISCOVERY_REASON, kind: 'generated', builderMissing: true });
      }
    }
    await this.writeManifest(nextFiles);
    // The icons count as published only now, once every file and the manifest claiming them are in place.
    if (icons.files) {
      this.iconsPublished = { key: icons.key, id: icons.id };
      await this.recordSiteIcons(icons, hashes);
    }
    this.contentHashes = hashes;
    // Only files still generated are worth remembering.
    for (const abs of this.seenOnDisk.keys()) if (!hashes.has(abs)) this.seenOnDisk.delete(abs);
    // A design's own file, one this app wrote, edited outside it and still text, can become a code component (#737).
    // Never a page, a stylesheet, the helpers or any other file, nor one that is gone, unreadable or binary.
    for (const c of this.conflicts) {
      const design = edited.has(c.path) ? designAt(this.state, c.path) : undefined;
      if (!design) continue;
      const read = await readFileAt(safeJoin(this.dir, c.path));
      if (typeof read === 'object' && textOfBytes(read.bytes) !== null) c.convert = { definitionId: design.id };
    }
    stretch();
    return changedFiles;
  }

  /**
   * On opening, take the website's icons in the project as the set for the project as it is when the record their
   * publication left says they are that very drawing: made from the same input (the favicon's bytes, the monogram, each
   * icon's size and background) by the same build of the renderer, and each still the bytes the generated manifest
   * claims for it. Nothing is drawn for them then. Any difference, or anything that cannot be read, and they are drawn.
   */
  private async recallSiteIcons(): Promise<IconInput | undefined> {
    if (this.iconsRecalled) return undefined;
    this.iconsRecalled = true;
    const where = siteIconRecord(this.dir);
    if (!where) return undefined;
    // A regular file of the app's own, read without waiting: anything else there is no record.
    const text = (await readTextAt(where.file))?.text ?? null;
    let record: { renderer?: unknown; dir?: unknown; key?: unknown; files?: Record<string, unknown> } | null = null;
    try {
      record = text ? JSON.parse(text) : null;
    } catch {
      record = null;
    }
    const input = await this.siteIcons.input(this.dir, this.state);
    if (!record || record.renderer !== where.renderer || record.dir !== this.dir || record.key !== input.key || !record.files || typeof record.files !== 'object') return input;
    const files = new Map<string, Buffer>();
    const known = new Map<string, { content: Buffer; hash: string }>();
    for (const { path } of input.icons) {
      const want = Object.hasOwn(record.files, path) ? record.files[path] : undefined;
      if (typeof want !== 'string' || this.generated.files[path] !== want) return input;
      const abs = safeJoin(this.dir, path);
      let bytes: Buffer | null = null;
      const { hash } = await this.readHash(abs, (b) => (bytes = b));
      if (hash !== want || !bytes) return input;
      files.set(path, bytes);
      known.set(abs, { content: bytes, hash });
    }
    this.iconsRecord = text;
    // Read and hashed just now: the publication finds them so, as it finds a file it generated before.
    for (const [abs, k] of known) this.contentHashes.set(abs, k);
    this.siteIcons.adopt(input.key, files);
    return input;
  }

  /** Note which drawing the icons a publication carried are, for the next opening (recallSiteIcons). A cache: never durable. */
  private async recordSiteIcons(icons: { key: string; files: Map<string, Buffer> | null; standIn: boolean }, hashes: Map<string, { hash: string }>): Promise<void> {
    const where = siteIconRecord(this.dir);
    // A stand-in for a picture that could not be decoded is drawn again in a while: never taken as the picture's.
    if (!where || !icons.files || icons.standIn) return;
    const files: Record<string, string> = {};
    for (const path of [...icons.files.keys()].sort()) {
      const hash = hashes.get(safeJoin(this.dir, path))?.hash;
      if (!hash) return;
      files[path] = hash;
    }
    const text = toJson({ renderer: where.renderer, dir: this.dir, key: icons.key, files });
    if (text === this.iconsRecord) return;
    await atomicWrite(where.file, text, { durable: false }).then(
      () => (this.iconsRecord = text),
      () => undefined
    );
  }

  private async writeManifest(files: Record<string, string>, pending?: Record<string, string>) {
    this.generated = { generator: GENERATOR_VERSION, files, ...(pending ? { pending } : {}) };
    const sorted = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).sort());
    const path = join(this.dir, 'siteorigin', 'generated-manifest.json');
    const text = toJson({ generator: GENERATOR_VERSION, note: 'Hashes of files generated by SiteOrigin Builder.', files: sorted(files), ...(pending ? { pending: sorted(pending) } : {}) });
    // The file holds this very text already, as opening read it and unchanged since (reopening a project whose files
    // are current): writing it again would change nothing on disk. Only the final manifest: claims written ahead of
    // replacing files are always written, and made to last, before any file is replaced. The folder is flushed, so the
    // file the last writer put there stays even if that writer stopped before flushing it.
    const read = this.manifestRead;
    this.manifestRead = null;
    if (!pending && read?.text === text) {
      // The very file read, in place: a link there is replaced by the manifest itself, as any write would.
      perf.count('files.stats');
      const now = await fs.lstat(path, { bigint: true }).catch(() => null);
      if (now?.isFile() && stampOf(now) === read.stamp) {
        await syncDir(dirname(path));
        this.manifestRead = read;
        return;
      }
    }
    await atomicWrite(path, text);
  }

  /** Restore a generated file from the managed documents, discarding the external edit. */
  restoreGeneratedFile(path: string): Promise<void> {
    return this.serialize(async () => {
      if (!(await this.stillOwner())) throw new Error(this.readOnly?.reason ?? LOCK_UNCHECKED);
      await this.restoreGeneratedLocked(path);
    });
  }

  /** Writes are refused while the project is read-only or a project document is in conflict. */
  private async writeBlocked(): Promise<ApplyResult | null> {
    if (!(await this.stillOwner())) {
      if (this.readOnly) return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: this.readOnly.reason, recoverable: false } };
      return { ok: false, revision: this.revision, error: { code: 'BUSY', message: LOCK_UNCHECKED, recoverable: true } };
    }
    if (this.pending.size) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: 'Resolve the file conflicts in Project health before making more changes.', recoverable: false } };
    // A new save would replace the journal the failed update left.
    if (this.migrationFailed) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: 'This project could not be updated to the current format. Close and reopen it.', recoverable: false } };
    // Nothing of this change is written, and reopening the project finishes only the earlier save: the editor keeps the
    // typed text to make again (#1435).
    if (this.unsettled) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: UNSETTLED, recoverable: false, details: { save: 'blocked' } } };
    return null;
  }

  private async restoreGeneratedLocked(path: string) {
    const content = await this.generatedContent(path);
    if (content === undefined) {
      if (claimedWhenObsolete(path) && this.generated.files[path]) return this.retireGeneratedLocked(path);
      if (SITE_ICON_PATHS.includes(path)) throw new Error('The site’s icons could not be made just now, so it was not restored. Try again in a moment.');
      throw new Error('That file is no longer generated.');
    }
    const abs = safeJoin(this.dir, path);
    // Kept byte for byte before it is replaced; a file that cannot be read is never replaced unkept.
    const disk = await readFileAt(abs);
    if (disk === 'failed' || disk === 'changed') throw new Error(`${path} could not be read, so it was not restored. Check that it is a file you can open, then try again.`);
    // A file that already is what SiteOrigin Builder makes has nothing of anyone else's to keep.
    if (disk !== 'missing' && !disk.bytes.equals(typeof content === 'string' ? Buffer.from(content) : content)) await this.saveCopy(path, 'generated', 'external', disk.bytes);
    this.seenOnDisk.delete(abs);
    // Saved again while the copy was kept: that save is not replaced unkept either.
    const unchanged = async () => {
      if (disk === 'missing' ? await absent(abs) : (await handleStamp(abs)) === disk.stamp) return true;
      throw new Error(`${path} changed while it was being restored, so it was not restored. Try again.`);
    };
    await this.publishing(async () => {
      await atomicWrite(abs, content, { beforeReplace: unchanged });
      this.landing?.add(path);
      this.generated.files[path] = sha(content);
      this.conflicts = this.conflicts.filter((c) => c.path !== path);
      await this.publishGenerated(false);
    });
    this.emit('changed', { revision: this.revision, changedDocs: [], changedFiles: [path], label: 'Restore generated file', source: 'user' } satisfies SessionEvent);
  }

  /**
   * Writes the generated files for a state already installed from disk. Should that fail, the files may still say what
   * the project said before (a page since made a draft, in llms-full.txt): the save is unfinished, so nothing more is
   * written and no export runs until the project is reopened.
   */
  private async publishInstalled(): Promise<string[]> {
    try {
      return await this.publishGenerated(false);
    } catch (e) {
      if (!this.readOnly) this.unsettled = true;
      throw e;
    }
  }

  /**
   * Restores a file for AI agents the website no longer has (see publishGenerated): the file itself is moved into the
   * recovery folder in one step and listed under Saved copies, so what is kept is exactly what was there, and nothing
   * is left part way under static/ whatever happens meanwhile.
   */
  private async retireGeneratedLocked(path: string) {
    const abs = safeJoin(this.dir, path);
    const st = await fs.lstat(abs).catch(() => null);
    if (st && !st.isFile()) throw new Error(`${path} is not a file, so it was not restored. Move it ${path.startsWith('static/') ? 'out of static/' : 'away'}, then try again.`);
    await this.publishing(async () => {
      if (st) {
        // Read first, so a list that cannot be added to stops the restore before anything moves.
        const listed = await this.loadSavedCopies({ forWrite: true });
        const id = randomBytes(8).toString('hex');
        const savedAt = Date.now();
        const file = `${LOCAL_DIR}/recovery/${savedAt}-${id}-${path.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)}.external`;
        const kept = safeJoin(this.dir, file);
        await ensureDir(dirname(kept));
        await fs.rename(abs, kept);
        this.landing?.add(path);
        this.seenOnDisk.delete(abs);
        const copy: SavedCopy = { id, path, kind: 'generated', side: 'external', savedAt, file };
        await atomicWrite(safeJoin(this.dir, `${LOCAL_DIR}/recovery/${SAVED_COPIES}`), toJson({ copies: [copy, ...listed] }));
        this.savedCopies = [copy, ...this.savedCopies];
      }
      // The claim stays until the publication below finds the path empty: a file put back there meanwhile is named again.
      await this.publishGenerated(false);
    });
    this.emit('changed', { revision: this.revision, changedDocs: [], changedFiles: [path], label: 'Restore generated file', source: 'user' } satisfies SessionEvent);
  }

  private async saveLocalState() {
    await this.writeRevision(this.revision);
  }

  private async writeRevision(revision: number) {
    await atomicWrite(this.local('state.json'), toJson({ revision }));
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** A save did not finish (see persist): nothing more is written until the project is reopened. */
  get saveUnfinished(): boolean {
    return this.unsettled;
  }

  /**
   * Whether `e` is what a save this session tried to write threw, and if so what became of that save (see WriteFailure).
   * Null for any other error.
   */
  writeFailure(e: unknown): WriteFailure | null {
    return e && typeof e === 'object' ? (this.writeFailures.get(e) ?? null) : null;
  }

  /** Whether the journal on disk still names the revision a save making `revision` gave it: not one put in its place since. */
  private journalOf(revision: number): boolean {
    try {
      return (JSON.parse(readFileSync(this.local('journal.json'), 'utf8')) as { revision?: unknown } | null)?.revision === revision;
    } catch {
      return false;
    }
  }


  /** A save that failed, for the editor's save indicator: an unfinished one until reopening, a failed one until a later save succeeds. */
  get saveFailure(): SaveFailure | null {
    if (this.unsettled || this.migrationFailed) return { kind: 'unfinished', ...(this.failedSave ? { label: this.failedSave.label } : {}), message: UNSETTLED };
    return this.failedSave ? { kind: 'failed', ...this.failedSave } : null;
  }

  /** Run `fn` while holding the writer lock, so no edit or regeneration lands while it reads the project. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.serialize(fn, false);
  }

  /**
   * Run `fn` only if this app still owns the project, holding the lock generation's claim throughout, so no takeover
   * can land between the check and `fn`. Says whether it ran.
   */
  whileOwner(fn: () => Promise<unknown>): Promise<boolean> {
    return this.serialize(async () => {
      if (this.lockState !== 'held' || !(await this.stillOwner())) return false;
      await fn();
      return true;
    });
  }

  /**
   * Record the page addresses an export delivered (`live`, the published project it was built from), so a page that
   * moves from one keeps it working (see shared/published). Only the record is written, outside History: no undo, and
   * no AI request running meanwhile, takes back an export. Null once it is recorded, or the reason it could not be.
   */
  recordPublished(live: Pick<ProjectState, 'pages'>): Promise<string | null> {
    return this.serialize(async () => {
      const published = withPublished(this.state.published, live);
      if (!published) return null;
      const blocked = await this.writeBlocked();
      if (blocked) return blocked.error?.message ?? 'The project can’t be saved right now.';
      // An AI request running now started before the record changed: the record is part of where it started, so
      // finishing, undoing or reverting the request never adds or takes back the export.
      const run = this.activeRun;
      const started = run ? { before: run.before.get(PUBLISHED_FILE), state: run.beforeState } : null;
      if (run) {
        run.before.set(PUBLISHED_FILE, toJson(published));
        run.beforeState = withRecord(run.beforeState, published);
      }
      try {
        await this.persist(withRecord(this.state, published), { label: 'Record exported addresses', history: false, source: 'system' });
      } catch (e) {
        if (run && started) {
          if (started.before === undefined) run.before.delete(PUBLISHED_FILE);
          else run.before.set(PUBLISHED_FILE, started.before);
          run.beforeState = started.state;
        }
        return e instanceof Error && e.message ? e.message : String(e);
      }
      return null;
    });
  }

  /** Commands run one at a time, each (unless it only reads) holding the lock generation's claim throughout. */
  private serialize<T>(fn: () => Promise<T>, writes = true): Promise<T> {
    const run = writes ? () => this.fenced(fn) : fn;
    const p = this.writing.then(run, run);
    this.writing = p.catch(() => undefined);
    return p;
  }

  /**
   * Take a copy of page content for the editor's Paste, as it is now, so the paste does not depend on the
   * original. `expectedRevision` is the revision the editor showed when Copy was pressed: a change that landed
   * since (another window, a file edited outside the app) could make the copy differ from what was on screen.
   */
  copy(pageId: string, nodeId: string | readonly string[], expectedRevision: number): Promise<{ ok: boolean; clipboardId?: string; message?: string }> {
    // Reads the project and keeps the copy in memory: nothing is written, so no lock claim is needed.
    return this.serialize(async () => {
      if (expectedRevision !== this.revision) return { ok: false, message: 'The project changed while copying. Copy it again.' };
      try {
        const clip = captureClipboard(this.state, pageId, nodeId);
        this.clipboards = [...this.clipboards.slice(-(CLIPBOARD_LIMIT - 1)), clip];
        return { ok: true, clipboardId: clip.id };
      } catch (e) {
        if (e instanceof EngineError) return { ok: false, message: e.message };
        throw e;
      }
    }, false);
  }

  /**
   * Validate and apply an edit batch. `runId` identifies the AI run that holds the writer lock;
   * manual edits are rejected while a run is active.
   */
  /**
   * `codeAllowed: false` refuses code, and copies that would make new code, as the project is when the batch applies.
   * `componentImport` is the checked package a `component.import` in the batch lands; only the editor's import has one.
   * `collectionWrite` is what the assistant's post tool may write in this one batch (see shared/collection-grant), and
   * `sourceWrite` the one source mapping or converter its source tool tested (see sources/grant.ts), and `briefWrite`
   * the one brief field its brief tool composed (see shared/brief).
   * `formRouting` is the grant `grantFormRouting` gave when the user allowed an AI batch that changes where a contact
   * form sends: used up by this call, whatever it does.
   * `guard` (CommitOptions) is also asked as the batch's turn comes, with no state, so a grant already gone costs nothing.
   */
  apply(
    batch: EditBatch,
    opts: CommitOptions & {
      runId?: string;
      idempotencyKey?: string;
      codeAllowed?: boolean;
      componentImport?: ComponentImport;
      collectionWrite?: CollectionWriteGrant;
      sourceWrite?: SourceWriteGrant;
      briefWrite?: BriefWriteGrant;
      sourceSync?: SourceSyncGrant;
      formRouting?: FormRoutingGrant;
      stillWanted?: () => boolean;
      /**
       * The author's held edit, saved while AI run `runId` waits for their answer (#1281), with what each field it writes
       * held when they made it (`base`): it lands only while every one still holds that both in the project and in the
       * run's checkpoint, which it is saved into too.
       */
      asking?: { runId: string; base: unknown[] };
    }
  ): Promise<ApplyResult> {
    // A form routing grant is good for one call at most, whichever way it goes, even one that never gets its turn.
    const routingGrant = opts.formRouting ? this.routingGrants.take(opts.formRouting) : null;
    // An edit's own work, once it is its turn (src/shared/perf.ts): the wait for that is the rest of controller.apply.
    return this.serialize(timed('session.apply', async (): Promise<ApplyResult> => {
      const refused = opts.guard?.(null);
      if (refused) return { ok: false, revision: this.revision, error: refused };
      const fingerprint = sha(JSON.stringify(batch.operations));
      if (opts.idempotencyKey && this.idempotency.has(opts.idempotencyKey)) {
        const prior = this.idempotency.get(opts.idempotencyKey)!;
        if (prior.fingerprint === fingerprint) return prior.result;
        return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'That tool call ID was already used for a different request.', recoverable: true } };
      }
      if (opts.runId && this.activeRun?.id !== opts.runId)
        return { ok: false, revision: this.revision, error: { code: 'CANCELLED', message: 'That AI request is no longer running.', recoverable: false } };
      const asking = opts.asking && !opts.runId && opts.source !== 'ai' ? opts.asking : null;
      if (opts.asking && (!asking || this.activeRun?.id !== asking.runId))
        return { ok: false, revision: this.revision, error: { code: 'CANCELLED', message: 'The AI request is no longer waiting for your answer.', recoverable: true } };
      if (this.activeRun && opts.runId !== this.activeRun.id && !asking)
        return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'The AI is making changes. Stop it before editing.', recoverable: true } };
      if (batch.expectedRevision !== undefined && batch.expectedRevision !== this.revision)
        return { ok: false, revision: this.revision, error: { code: 'STALE_REVISION', message: `Expected revision ${batch.expectedRevision} but the project is at ${this.revision}. Read the latest state and try again.`, recoverable: true } };
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      const ops = [];
      const decoding = perf.span('session.validateOperations', { operations: batch.operations.length });
      for (const raw of batch.operations) {
        const v = validateOperation(raw);
        // A source's settings may hold the very credential they should only name: the problem is said in fixed words.
        const settings = (raw as { type?: unknown })?.type === 'source.upsert';
        if (!v.ok)
          return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: settings ? 'A source’s settings are not valid: name each credential it signs in with as { "$secret": "<name>" }, never its value.' : v.message, recoverable: true } };
        ops.push(v.op);
      }
      decoding();
      // Saved while the AI waits: only a typed edit of fields that hold, in the project and in the run's checkpoint, what
      // the author saw. One the run changed, or on something the run made, waits for the request to end.
      if (asking) {
        const refusal = heldRefusal(this.state, this.activeRun!.beforeState, ops, asking.base);
        if (refusal) return { ok: false, revision: this.revision, error: refusal };
      }
      // Checked here, in turn with every other edit and with the editor's clipboard, so what it copies is what lands.
      const importing = ops.some((o) => o.type === 'component.import');
      // A package is read and checked by the editor's import, which is the only way one reaches a project.
      if (importing && (opts.source === 'ai' || opts.runId))
        return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: 'Only the editor can import a component package. Ask the user to import it from the component library.', recoverable: true } };
      // An import is a change of its own (its images and the package), checked against the project as it stands.
      if (importing && (ops.filter((o) => o.type === 'component.import').length !== 1 || ops.some((o) => o.type !== 'asset.add' && o.type !== 'component.import')))
        return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'A component package is imported as a change of its own, with only its images.', recoverable: true } };
      // The parts and slots each code source in the batch shows, read from its syntax tree before the batch is applied,
      // so its own later operations can fill a slot or style a part the code just gained.
      const names = new Map<string, { parts: string[]; slots: string[]; shown: string[] } | null>();
      for (const op of ops) if ((op.type === 'component.createCode' || op.type === 'component.updateSource') && typeof op.source === 'string' && !names.has(op.source)) names.set(op.source, await codeContractNames(op.source));
      // A theme switch asks which slots each code component of both themes shows, so content a placement holds in a
      // slot the new code never renders is reported before it is lost. The current theme's own versions are read too:
      // an earlier operation of the batch may install or refresh one.
      if (ops.some((o) => o.type === 'theme.apply')) {
        const targets = new Set([this.state.site.themeId, ...ops.flatMap((o) => (o.type === 'theme.apply' ? [o.themeId] : []))]);
        const switching = [...Object.values(this.state.components).filter((d) => d.owner === 'theme'), ...listThemes().filter((t) => targets.has(t.id)).flatMap((t) => t.components)];
        for (const d of switching) if (d.kind === 'code' && Object.keys(d.slots ?? {}).length && typeof d.source === 'string' && !names.has(d.source)) names.set(d.source, await codeContractNames(d.source));
      }
      // A sync of an external source writes its collection's entries, and nothing else: only the main process's sync
      // gives the grant, never an AI run.
      if (opts.sourceSync && (opts.source === 'ai' || opts.runId))
        return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: 'Only a sync can write a synced collection.', recoverable: false } };
      const syncRefusal = opts.sourceSync ? sourceSyncRefusal(ops, opts.sourceSync) : null;
      // A sync its project stopped wanting while this waited its turn (it is closing) lands nothing.
      if (opts.sourceSync && opts.stillWanted && !opts.stillWanted()) return { ok: false, revision: this.revision, error: { code: 'CANCELLED', message: 'The sync was stopped.', recoverable: false } };
      if (syncRefusal) return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: syncRefusal, recoverable: false } };
      const context = {
        clipboards: this.clipboards,
        codeNames: (source: string) => names.get(source),
        ...(opts.componentImport ? { componentImport: opts.componentImport } : {}),
        ...(opts.sourceSync ? { sourceSync: opts.sourceSync } : {}),
        ...(perf.on ? { span: (name: string) => perf.span(name) } : {})
      };
      const code = opts.codeAllowed === false ? developerModeRefusal(this.state, ops, context) : null;
      if (code) return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: `${code} Turn on Developer mode in Settings to work with code.`, recoverable: true } };
      // Paste places what the editor copied; an AI run never sends it.
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'node.paste'))
        return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'node.paste is only for the editor. Use node.copy.', recoverable: true } };
      // So is the order of a component's properties, set in Edit everywhere's property list.
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'component.orderProperties'))
        return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'component.orderProperties is only for the editor.', recoverable: true } };
      // And a component's placement role, chosen in Component Studio (#661).
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'component.setInsertAs'))
        return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'component.setInsertAs is only for the editor.', recoverable: true } };
      // The project brief is the author's own (#518): the assistant reads it as background (#519), and changes it only
      // as its brief tool composed, when the author asked (#1407).
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'brief.update')) {
        const refused = opts.briefWrite ? briefWriteRefusal(ops, opts.briefWrite, this.state.brief) : 'The project brief can only be changed in the editor, or with update_project_brief when the author asks for it.';
        if (refused) return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: refused, recoverable: true } };
      }
      // So are external sources' settings (#676), which name the secrets the user signs in with, apart from the one
      // mapping or converter the assistant's source tool tested (#680), as it tested it.
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'source.upsert' || o.type === 'source.remove')) {
        const refused = opts.sourceWrite ? sourceWriteRefusal(ops, opts.sourceWrite, this.state.sources) : 'External sources can only be changed in the editor.';
        if (refused) return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: refused, recoverable: true } };
      }
      // The assistant reaches a collection only through its collection and entry tools, and a layout only from a request
      // sent while it is open or through a whole-site run's layout tool: each grants exactly that batch (see
      // shared/collection-grant). Any other collection change
      // is the editor's.
      const ai = opts.source === 'ai' || !!opts.runId;
      const granted = ai && opts.collectionWrite ? collectionGrantRefusal(ops, opts.collectionWrite, this.state.collections) : null;
      if (granted) return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: granted, recoverable: true } };
      if (ai && !opts.collectionWrite && ops.some(isCollectionOperation))
        return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: 'Collections, their entries and their layouts can only be changed in the editor, apart from what define_collection, upsert_collection_entry and edit_collection_layout write and a layout edited from a request sent while it is open.', recoverable: true } };
      // A fork of every placement moves a collection layout's too, which is the editor's in the same way: the placements
      // the request covers are listed instead. So does new code's whole property schema, which renames or drops the values
      // a layout's placement holds: the code alone may change. Each is checked against the project as the batch leaves it
      // then (a theme switch before it rebinds a layout's placements to the new theme's component).
      const reachesLayouts = (o: EditOperation): o is Extract<EditOperation, { type: 'component.fork' | 'component.updateSource' }> => (o.type === 'component.fork' && !o.placements) || (o.type === 'component.updateSource' && o.properties !== undefined);
      const inLayouts =
        ai && !opts.collectionWrite && ops.some(reachesLayouts)
          ? walkOperations(this.state, ops, (draft, o) => {
              if (!reachesLayouts(o) || !instancesOf(draft, o.definitionId).some((u) => u.owner.kind === 'template' || u.owner.kind === 'archive')) return null;
              const name = `“${draft.components[o.definitionId]?.name ?? o.definitionId}”`;
              return o.type === 'component.fork'
                ? `${name} is also placed in a collection layout, which only the editor changes. List the placements the copy is for in placements.`
                : `${name} is placed in a collection layout, whose values only the editor changes: change its code alone, or ask the user to change its properties in the editor.`;
            }, context)
          : null;
      if (inLayouts) return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: inLayouts, recoverable: true } };
      // A library image's file is only ever one the importer checked and wrote.
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'asset.relink'))
        return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: 'Only the editor can give an image a new file. Ask the user to locate it in Assets.', recoverable: true } };
      // Removing a file of a font the site uses changes how its text is drawn: the author decides, having seen what changes.
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'asset.remove' && o.fontUses !== undefined))
        return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: 'Only the editor can remove a file of a font the site uses. Change the styles that use the font first, or ask the user to remove the file in Assets, where they see what changes.', recoverable: true } };
      let next: ProjectState;
      let results;
      const applying = perf.span('session.applyOperations');
      // A batch the user allowed lands as it was when they were shown it (#1129): made again, it would have new IDs, and
      // an item's ID is something a form's code may send by.
      const run = this.activeRun?.id ?? null;
      const allowed = ai ? reviewed(routingGrant, this.state, this.revision, run, fingerprint) : null;
      try {
        ({ state: next, results } = allowed ? { state: allowed.state, results: allowed.results } : applyOperations(this.state, ops, context));
      } catch (e) {
        applying({ ok: false });
        if (e instanceof EngineError) return { ok: false, revision: this.revision, error: { code: e.code, message: e.message, recoverable: true, details: e.details } };
        return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: (e as Error).message, recoverable: true } };
      }
      applying({ ok: true });
      if (perf.on) perf.count('apply.docsCopied', docsCopied(this.state, next));
      const pin = themePinProblem(next);
      if (pin) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: pin, recoverable: false } };
      // Any authored code that is new or changed must pass the safety checks before it can be saved. Imports
      // are followed into the components as they will be once this batch is saved, whichever order it made them in.
      const resolve = componentSources(next.components);
      // A package's code was written by someone else, for another project: it is held to the assistant's policy, and may
      // import only what the package brought (as saved, or as the app generates it here) and the runtime the site has.
      const brought = importing ? this.importedComponents(next, ops, results) : null;
      let built: Map<string, string> | null = null;
      if (brought) {
        try {
          built = generateProject(next, { instrument: false });
        } catch (e) {
          return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: `The package's components are damaged: ${(e as Error).message}`, recoverable: true } };
        }
      }
      // A form decides in its code where visitors' messages go, so a package's code may never place one.
      const guarded = new Set(results.flatMap((r) => (Array.isArray(r?.guarded) ? (r.guarded as string[]) : [])));
      const files = brought ? new Set(brought.filter((d) => !sendsFormMessages(d) && !guarded.has(d.id)).map(defFile)) : null;
      let modules: ((path: string) => boolean) | undefined;
      for (const def of Object.values(next.components)) {
        if (def.kind !== 'code' || def.source === undefined) continue;
        const was = this.state.components[def.id];
        // What its code is held to of its manifest (a design's edited file takes what the design's file took: see
        // the generator's designCalled), checked alone against code that passed its other checks: unchanged code (a
        // theme refresh among them), or code the app ships.
        const manifest = designCalled(next, def) ? { ...def, designFile: true } : def;
        const axesOnly = async () => {
          const errors = [...((await codeAxisPropProblems(def.source!, def.variantAxes)) ?? []), ...((await codeManifestProblems(def.source!, manifest, opts.source === 'ai' || importing)) ?? [])].filter((p) => p.severity === 'error');
          return errors.length ? ({ ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: `The code for "${def.name}" has problems: ${errors.map((e) => (e.line ? `line ${e.line}: ` : '') + e.message).join(' ')}`, recoverable: true, details: errors } } as const) : null;
        };
        if (was?.source === def.source) {
          // The assistant's change to the properties of a project's own code is held to the contract of the unchanged
          // code too: renaming or removing one can leave text the code marks for typing over naming a property or field it
          // no longer has. Only what the new properties bring counts (the code passed its checks when it was saved): it is
          // checked against the contract as it lands with the old properties and with the new, so an error that is there
          // either way refuses nothing. What the code takes from $props() is held to the new ones by the manifest check.
          if (ai && def.owner === 'project' && JSON.stringify(was.properties) !== JSON.stringify(def.properties)) {
            const source = def.source;
            const contracted = async (properties: ComponentDefinition['properties']) =>
              (await checkSvelteSource(source, { filename: def.sourcePath, resolve, contract: { slots: def.slots, parts: def.parts, filled: filledSlots(next, def), variantAxes: def.variantAxes, properties } })).filter((p) => p.severity === 'error');
            const had = new Set((await contracted(was.properties)).map((p) => p.message));
            const fresh = (await contracted(def.properties)).filter((p) => !had.has(p.message));
            if (fresh.length)
              return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: `The code for "${def.name}" does not fit its new properties: ${fresh.map((e) => (e.line ? `line ${e.line}: ` : '') + e.message).join(' ')}`, recoverable: true, details: fresh } };
          }
          // Unchanged code passed its checks when it was saved: only a change of what it is held to of its manifest is.
          if (manifestKey(was) === manifestKey(def)) continue;
          const refused = await axesOnly();
          if (refused) return refused;
          continue;
        }
        // Placing a theme's own component (the contact form, say) authors no code when it is code the app ships,
        // whichever pack reuses it; nor does a package bringing that code to a site whose theme lacks it, unchanged
        // with the settings it takes (a form's destinations are emptied as it lands). Under a mapping of its axes other
        // than the one it ships with, those are checked.
        const shipped = (c: ComponentDefinition) => c.kind === 'code' && c.source === def.source && (def.owner === 'theme' || (importing && JSON.stringify(c.properties) === JSON.stringify(def.properties)));
        const shippedAs = (def.owner === 'theme' || importing) && listThemes().flatMap((t) => (t.source !== 'user' ? t.components.filter(shipped) : []));
        if (shippedAs && shippedAs.length) {
          if (shippedAs.some((c) => manifestKey(c) === manifestKey(def))) continue;
          const refused = await axesOnly();
          if (refused) return refused;
          continue;
        }
        // Code the AI writes is held to a stricter policy than code a developer writes, and so is an installed pack's
        // own code, which nobody here wrote or reviewed.
        const installed = def.owner === 'theme' && listThemes().some((t) => t.source === 'user' && t.components.some((c) => c.id === def.id));
        const errors = (
          await checkSvelteSource(def.source, {
            strict: opts.source === 'ai' || installed || importing,
            filename: def.sourcePath,
            tokens: projectTokenVars(next),
            // A project's own code is held to its contract: the slots it declares must render safely when left empty.
            ...(def.owner === 'project' ? { contract: { slots: def.slots, parts: def.parts, filled: filledSlots(next, def), variantAxes: def.variantAxes, properties: def.properties } } : {}),
            // Its code takes what its properties hold, and nothing they do not.
            manifest,
            resolve: files ? (p: string) => (files.has(p) ? resolve(p) : undefined) : resolve,
            // Every file it imports is there once the change lands: compiling it alone never notices one missing.
            ...(files && built
              ? { author: 'Code in a component package', generated: (p: string) => files.has(p), modules: (p: string) => files.has(p) || (p.startsWith('src/lib/siteorigin/runtime/') && built!.has(p)) }
              : { modules: (modules ??= this.projectModules(next)) })
          })
        ).filter((p) => p.severity === 'error');
        // A theme's or a package's code is held to its axes' props alone (its slots and parts are the theme's to check).
        if (!errors.length && def.owner !== 'project') errors.push(...((await codeAxisPropProblems(def.source, def.variantAxes)) ?? []).filter((p) => p.severity === 'error'));
        if (errors.length)
          return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: `The code for "${def.name}" has problems: ${errors.map((e) => (e.line ? `line ${e.line}: ` : '') + e.message).join(' ')}`, recoverable: true, details: errors } };
      }
      // A package's designs are generated here for the first time: each must compile, for the server and the browser.
      if (brought && built) {
        const problem = await compileDesigns(brought.filter((d) => d.kind === 'managed' && d.owner === 'project' && !Object.hasOwn(this.state.components, d.id)), built);
        if (problem) return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: problem, recoverable: true } };
      }
      // A design built whole is generated here before it is saved: it must compile, for the server and the browser.
      const upserted = [...new Set(ops.flatMap((o, i) => (o.type === 'component.upsert' && typeof results[i]?.definitionId === 'string' ? [results[i].definitionId as string] : [])))];
      if (upserted.length) {
        const defs = upserted.flatMap((id) => (Object.hasOwn(next.components, id) ? [next.components[id]] : []));
        let problem: string | null;
        try {
          problem = await compileDesigns(defs, new Map(defs.map((d) => [defFile(d), generateManagedComponent(next, d, { instrument: false })])), "can't be saved");
        } catch (e) {
          problem = `The design can't be generated: ${(e as Error).message}`;
        }
        if (problem) return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: problem, recoverable: true } };
      }
      // An import is checked place by place: a problem in what it brings is new even if another component has the same.
      let introduced: Diagnostic[];
      const validating = perf.span('session.validateState');
      try {
        introduced = importing ? this.introducedProblems(next) : introducedDiagnostics(this.savingProblems(this.state), this.savingProblems(next));
        // A property made required reports each placement already missing it, rather than refusing the change.
        const asked: ReadonlyArray<{ type: string; definitionId?: unknown }> = ops;
        introduced = introduced.filter((d) => !madeRequiredBy(this.state, next, asked, d));
      } catch (e) {
        if (!importing) throw e;
        return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: `The package's components are damaged: ${(e as Error).message}`, recoverable: true } };
      }
      validating({ introduced: introduced.length });
      if (introduced.length)
        return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: introduced.map((d) => d.message).join(' '), recoverable: true, details: introduced } };
      // Where a contact form sends visitors' messages is the user's to change (#1128), however a batch of the assistant's
      // gets there: it lands only with the user's say for exactly the changes it makes, given when the app asked them
      // (agent/orchestrator.ts), at the revision it was asked at (#1129). Asked last, so the user is never asked about a
      // batch that could not land anyway.
      if (ai) {
        const routing = formRoutingChanges(this.state, next);
        if (!admits(routingGrant, this.revision, run, fingerprint, routing)) {
          const review: FormRoutingReview = this.routingGrants.review(this.revision, run, fingerprint, routing, { base: this.state, state: next, results });
          return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: formRoutingRefusal(routing), recoverable: true, details: { formRouting: review } } };
        }
      }
      // A theme switch restyles the whole site: the site as it is first goes to Saved versions (#1156), or one there
      // already holding exactly that stands for it. If it can't be saved, the theme stays as it is. An AI request's own
      // switch is not saved so: its documents are provisional, and stopping it, or Undo, takes the whole request back.
      if (next.site.themeId !== this.state.site.themeId && !opts.runId) {
        try {
          const blocked = this.versions.problem;
          if (blocked) throw new Error(blocked);
          await this.listAuto(await this.captureAuto(BEFORE_THEME));
        } catch (e) {
          return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: `The site could not be saved first, so the theme was not changed. ${(e as Error).message}`, recoverable: true } };
        }
      }
      // The same edit made to the run's checkpoint, which stopping the run or a crash restores: it must land there as it
      // lands in the project, and leave the checkpoint as valid as it was.
      let rebaseRun: ProjectState | undefined;
      if (asking) {
        const start = this.activeRun!.beforeState;
        let made: ProjectState;
        try {
          made = applyOperations(start, ops, context).state;
        } catch (e) {
          return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `${EARLY_SAVE_WAITS} ${(e as Error).message}`, recoverable: true, details: { held: 'differs' } } };
        }
        // Everything the edit changes, as it lands in either: the fields it names and what the engine changes with them (a
        // header that follows the site's name, the pages inside a moved one). Each must end up the same in both, or the
        // request touched something the edit changes, and stopping it would take part of the edit back.
        const touched = new Set([...stateDelta(this.state, next).keys(), ...stateDelta(start, made).keys()]);
        const differs = [...touched].some((at) => !sameValue(valueAt(next, at), valueAt(made, at)));
        const problem = themePinProblem(made) ?? (differs ? 'The AI changed something this edit changes too, in this request.' : null);
        const introducedThere = problem ? [] : introducedDiagnostics(this.savingProblems(start), this.savingProblems(made));
        if (problem || introducedThere.length)
          return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `${EARLY_SAVE_WAITS} ${problem ?? introducedThere.map((d) => d.message).join(' ')}`, recoverable: true, details: { held: 'differs' } } };
        rebaseRun = made;
      }
      let ev: SessionEvent;
      const persisting = perf.span('session.persist');
      try {
        // A sync is planned from the whole collection, its source's settings and every link to its entries. An edit saved
        // while the AI waits is a step of its own, never joined to one before the request.
        ev = await this.persist(next, {
          ...opts,
          ...(rebaseRun ? { rebaseRun, coalesceKey: undefined } : {}),
          wholeProject: !!opts.sourceSync || ops.some((o) => o.type === 'theme.refresh' || o.type === 'theme.apply' || readsWholeProject(o, this.state))
        });
      } catch (e) {
        if (e instanceof DiskConflictError) return { ok: false, revision: this.revision, error: this.diskConflict(e) };
        if (e instanceof GuardRefusal) return { ok: false, revision: this.revision, error: e.refusal };
        throw e;
      } finally {
        persisting();
      }
      // Nothing filed before this save can be granted or used now.
      this.routingGrants.forget(this.revision);
      const result: ApplyResult = { ok: true, revision: this.revision, results, changed: ev.changedDocs, entryId: ev.entryId };
      if (opts.idempotencyKey) this.idempotency.set(opts.idempotencyKey, { fingerprint, result });
      return result;
    }, (r) => ({ ok: r?.ok ?? false, revision: this.revision })));
  }

  /**
   * The grant for a form routing review this session filed (`apply`'s refusal), once the user allowed it when the app
   * asked them: the app's own call, never the model's (agent/orchestrator.ts). Null when the review is not one this
   * session filed, was already granted, was filed under another run, or the project changed since: what the user saw
   * is no longer what would land.
   */
  grantFormRouting(reviewId: string): FormRoutingGrant | null {
    return this.routingGrants.grant(reviewId, this.revision, this.activeRun?.id ?? null);
  }

  /** The definitions a batch's `component.import` brought or kept from the theme, as they are in `next`. */
  private importedComponents(next: ProjectState, ops: EditOperation[], results: Array<Record<string, unknown>>): ComponentDefinition[] {
    const at = ops.findIndex((o) => o.type === 'component.import');
    const ids = (results[at]?.definitionIds as unknown[] | undefined) ?? [];
    return ids.flatMap((id) => (typeof id === 'string' && Object.hasOwn(next.components, id) ? [next.components[id]] : []));
  }

  /** Library images whose files are missing from the project folder, as `refreshAssetFiles` last found them. */
  missingAssets: MissingAssetFiles[] = [];
  private assetCheck = 0;

  /**
   * Look for the library's image files again. True when what is missing changed; an older check that finishes after a
   * newer one started changes nothing.
   */
  async refreshAssetFiles(): Promise<boolean> {
    const check = ++this.assetCheck;
    const found = await findMissingAssetFiles(this.dir, this.state.assets.assets);
    if (check !== this.assetCheck || JSON.stringify(found) === JSON.stringify(this.missingAssets)) return false;
    this.missingAssets = found;
    return true;
  }

  /** The sample content the author kept as it is, and the Component showcase's own placements (see withoutKeptSamples). */
  private keptSamples: { kept: ReadonlySet<string>; fixtures: ReadonlySet<string> } = { kept: new Set(), fixtures: new Set() };

  /** What this opening's workspace state says of sample content: kept as it is, and placed by the showcase on purpose. */
  keepSamples(kept: readonly string[] | undefined, fixtures: readonly string[] | undefined) {
    const strings = (v: readonly unknown[] | undefined) => new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string'));
    this.keptSamples = { kept: strings(kept), fixtures: strings(fixtures) };
  }

  /**
   * Document problems, without the sample content the author kept as it is. File conflicts are reported separately
   * (`conflicts`), with their actions, never twice.
   */
  diagnostics(): Diagnostic[] {
    try {
      const missing = this.missingCode();
      const problems = withoutKeptSamples(this.problemsOf(this.state), this.keptSamples.kept, this.keptSamples.fixtures);
      return missing.length ? [...missing, ...problems] : problems;
    } catch (e) {
      // A project from a newer version may not follow this version's shapes; it is open read-only anyway.
      if (this.readOnly) return [];
      throw e;
    }
  }

  /**
   * Project code components whose file was not there when the project was read (#1540), named with their file: their
   * pages can't be built until it is put back or the component is removed. A file held as a conflict is said there.
   */
  missingCode(): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const def of Object.values(this.state.components)) {
      if (def.kind !== 'code' || def.owner !== 'project' || !def.sourcePath || !this.absentSources.has(def.sourcePath) || this.pending.has(def.sourcePath)) continue;
      out.push({ severity: 'error', code: 'CODE_SOURCE_MISSING', owner: { kind: 'component', id: def.id }, site: def.sourcePath, message: missingCodeMessage(def.name, def.sourcePath) });
    }
    return out;
  }

  /** How many places use each library asset. */
  assetUsages(): Record<string, number> {
    return this.memo(this.state, 'usages', (st) => assetUsages(st, this.usageParts(st)));
  }

  /** What asset usage may keep from the last state's count: none when the state cannot be read for validation (read-only). */
  private usageParts(state: ProjectState) {
    try {
      return this.validation.keeper(state);
    } catch {
      return undefined;
    }
  }

  /** Theme components with a newer version available. */
  themeUpdates(): ThemeUpdates {
    return this.memo(this.state, 'updates', themeUpdates);
  }

  /** Every problem `validateState` finds in `state`, as Project health shows them, worked out once. */
  private problemsOf(state: ProjectState): Diagnostic[] {
    return this.memo(state, 'diagnostics', (st) => joinValidation(this.coreOf(st), adviceValidation(st, this.validation)));
  }

  /** Problems that stop a state from being saved. */
  private savingProblems(state: ProjectState): Diagnostic[] {
    return this.memo(state, 'saving', (st) => this.coreOf(st).core.filter(blocksSaving));
  }

  /**
   * What a save gate checks of `state` (`validateState` without the advice), worked out once: the save gate and Project
   * health share it, so the edit that makes a state checks it once and the snapshot adds only the advice. Always worked
   * out inside the check that asks for it (`saving` or `diagnostics`), whose time it is.
   */
  private coreOf(state: ProjectState): CoreValidation {
    const checks = this.checksOf(state);
    return (checks.core ??= coreValidation(state, this.validation));
  }

  /**
   * The problems stopping `next` from being saved that the open project does not already have: an external change is
   * refused for what it brings in, as an edit is, not for an older problem it leaves as it was.
   */
  private introducedProblems(next: ProjectState): Diagnostic[] {
    return introducedDiagnostics(this.savingProblems(this.state), this.savingProblems(next), { byNode: true });
  }

  /**
   * A check of `state`, worked out once. Only states the session holds or is about to hold come here, and those are
   * never changed after they are made; a check that throws is not kept.
   */
  private memo<K extends 'diagnostics' | 'saving' | 'usages' | 'updates'>(state: ProjectState, key: K, compute: (state: ProjectState) => NonNullable<ReturnType<ProjectSession['checksOf']>[K]>) {
    const checks = this.checksOf(state);
    if (checks[key] !== undefined) return checks[key];
    // Timed only when it is worked out (scripts/perf: the edit scenario's checks).
    const timing = perf.span('session.check', { check: key });
    const value = compute(state);
    timing();
    return (checks[key] = value);
  }

  /**
   * What a committed state keeps of the checks of the state it replaced. Its theme updates, while there were none and
   * the commit changed only pages, collection entries and the site document, naming the same theme: with none, theme
   * updates read only the installed theme components, the site's theme and the packs, which load once while the app runs.
   */
  private carryChecks(from: ProjectState, to: ProjectState, changed: readonly string[]) {
    const updates = this.derived.get(from)?.updates;
    if (!updates || updates.available.length || updates.kept.length || from.site.themeId !== to.site.themeId) return;
    if (!changed.every((path) => path === SITE_DOC || PAGE_DOC.test(path) || collectionPathOf(path)?.entryId !== undefined)) return;
    this.checksOf(to).updates ??= updates;
  }

  private checksOf(state: ProjectState) {
    let checks = this.derived.get(state);
    if (!checks) this.derived.set(state, (checks = {}));
    return checks;
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  /**
   * The history after recording `docs` as one step at `revision`, built on a copy: nothing changes until it is
   * installed, so it can be journaled with the change it records. `entryId` is the entry that holds the step.
   */
  private planHistory(docs: HistoryEntry['docs'], opts: CommitOptions & { runId?: string; restore?: boolean }, revision: number): { history: HistoryFile; pruned: boolean; entryId: string } {
    const h = structuredClone(this.history);
    noteDropped(h, h.entries.slice(h.cursor), 'undone');
    h.entries = h.entries.slice(0, h.cursor);
    const last = h.entries[h.entries.length - 1];
    let id: string;
    // Only a change that carries on from where the last step left its documents: one made in between without a step of
    // its own (a sync) would otherwise be taken back with them.
    const joins = !!last && Object.entries(docs).every(([path, d]) => !last.docs[path] || last.docs[path].after === d.before);
    if (opts.coalesceKey && last?.coalesceKey === opts.coalesceKey && Date.now() - Date.parse(last.time) < 4000 && joins) {
      id = last.id;
      for (const [path, d] of Object.entries(docs)) {
        if (last.docs[path]) last.docs[path].after = d.after;
        else last.docs[path] = d;
      }
      last.time = new Date().toISOString();
      last.revision = revision;
    } else {
      id = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      h.entries.push({
        id,
        label: opts.label,
        source: opts.source ?? 'user',
        time: new Date().toISOString(),
        revision,
        docs,
        coalesceKey: opts.coalesceKey,
        runId: opts.runId,
        ...(opts.revertsRunId ? { revertsRunId: opts.revertsRunId } : {}),
        ...(opts.guestName ? { guestName: opts.guestName } : {}),
        ...(opts.restore ? { restore: true as const } : {})
      });
    }
    const pruned = h.entries.length > HISTORY_LIMIT;
    if (pruned) {
      noteDropped(h, h.entries.slice(0, h.entries.length - HISTORY_LIMIT), 'applied');
      h.entries = h.entries.slice(h.entries.length - HISTORY_LIMIT);
    }
    h.cursor = h.entries.length;
    return { history: h, pruned, entryId: id };
  }

  private async installHistory(history: HistoryFile) {
    this.history = history;
    await atomicWrite(this.local('history', 'history.json'), toJson(history));
  }

  /** Record a step for a change already on disk (one made outside the app, or a settled conflict). */
  private async recordHistory(docs: HistoryEntry['docs'], opts: CommitOptions & { runId?: string }) {
    const planned = this.planHistory(docs, opts, this.revision);
    await this.installHistory(planned.history);
    // Collect when history was pruned, and every so often for blobs left by provisional AI batches and undo.
    if (planned.pruned || --this.gcCountdown <= 0) this.sweepSoon();
  }

  /** Asset imports in progress: their files are written before their asset records, so no asset sweep runs meanwhile. */
  private importing = 0;
  /** Set while a sweep or a reclaim decides which files in static/assets/ to delete: imports wait for it. */
  private assetGate: Promise<void> | null = null;
  async withImport<T>(fn: () => Promise<T>): Promise<T> {
    // An import can write a file under the very name a sweep has found unused, so it waits for the sweep to finish.
    while (this.assetGate) await this.assetGate;
    this.importing++;
    try {
      return await fn();
    } finally {
      this.importing--;
    }
  }

  /** Run `fn` with imports held off. While an import is in progress nothing runs, and the result is null. */
  private async gateAssets<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.importing || this.assetGate) return null;
    let open!: () => void;
    this.assetGate = new Promise<void>((r) => (open = r));
    try {
      return await fn();
    } finally {
      this.assetGate = null;
      open();
    }
  }

  /**
   * Give library images the copies made for them after they were added (#979). Each fill names the image, the file and
   * content (`hash`) its copies were made from, and the copies, already written: a record still waiting for them
   * (copiesPending) with that file and content gets them and stops waiting, and everything else about it (a name or alt
   * text changed meanwhile) stays as it is. Any other fill is left out: the image has gone, been given another file, or
   * already has its copies. The change is no step of its own: it is folded into History (amendHistory), so Undo takes
   * back the import that added the images, copies and all. Waits while an AI request is changing the project, and is
   * never made in a project this app may not write. Returns the images that got their copies.
   */
  fillCopies(fills: ReadonlyArray<{ assetId: string; file: string; hash: string; variants: ReadonlyArray<{ width: number; file: string }> }>): Promise<{ ok: boolean; filled: string[]; busy?: boolean }> {
    return this.serialize(timed('session.fillCopies', async (): Promise<{ ok: boolean; filled: string[]; busy?: boolean }> => {
      if (this.activeRun) return { ok: false, filled: [], busy: true };
      if (await this.writeBlocked()) return { ok: false, filled: [] };
      const assets = this.state.assets.assets;
      const taken = fills.filter((f) => {
        const a = Object.hasOwn(assets, f.assetId) ? assets[f.assetId] : undefined;
        return !!a && a.kind === 'image' && a.copiesPending === true && a.file === f.file && a.hash === f.hash && f.variants.every((v) => copyOf(a.file, v.file));
      });
      if (!taken.length) return { ok: true, filled: [] };
      const nextAssets = { ...assets };
      for (const f of taken) {
        const { copiesPending: _done, ...rest } = assets[f.assetId];
        nextAssets[f.assetId] = f.variants.length ? { ...rest, variants: f.variants.map((v) => ({ width: v.width, file: v.file })) } : rest;
      }
      const next: ProjectState = { ...this.state, assets: { ...this.state.assets, assets: nextAssets } };
      try {
        await this.persist(next, { label: taken.length === 1 ? 'Add image copies' : `Add copies of ${taken.length} images`, source: 'system', history: false, amendHistory: true });
      } catch (e) {
        // The assets file changed outside the app: the images keep waiting, and are filled once it has been read.
        if (e instanceof DiskConflictError) return { ok: false, filled: [] };
        throw e;
      }
      return { ok: true, filled: taken.map((f) => f.assetId) };
    }, (r) => ({ filled: r?.filled.length ?? 0 })));
  }

  /**
   * History retention (spec 18.4): keep at most 100 groups and 512 MiB of history blobs, pruning the oldest
   * groups first, then delete blobs nothing references and imported asset files that neither the project,
   * its retained history, an active run nor a held conflict can still need. Never fails a save.
   */
  collectGarbage(): Promise<void> {
    // Queued behind any save, so a blob is never swept between being written and being recorded.
    return this.serialize(() => this.sweep());
  }

  /** How long after a save makes a sweep due it runs (sweepSoon). */
  sweepDelayMs = 1000;
  private sweepTimer: NodeJS.Timeout | null = null;

  /**
   * A sweep a save made due (History let a step go, or enough saves have passed since the last) runs a moment after the
   * save, in its turn like any command, never inside it: no edit waits on a scan of the project's history and asset
   * folders before it is acknowledged. Made due again before it runs, it runs once.
   */
  private sweepSoon() {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = null;
      this.collectGarbage().catch(() => undefined);
    }, this.sweepDelayMs);
    this.sweepTimer.unref?.();
  }

  private async sweep(): Promise<void> {
    const sweeping = perf.span('session.sweep');
    try {
      // A save waiting for reopening may need files only its journal names.
      if (this.unsettled || !(await this.stillOwner())) return;
      this.gcCountdown = 25;
      try {
        await this.collectGarbageNow();
      } catch {
        /* best effort: a failed sweep is retried next time */
      }
    } finally {
      sweeping();
    }
  }

  /** The size of every stored history version, by hash. */
  private async blobSizes(): Promise<Map<string, number>> {
    const blobDir = this.local('history', 'blobs');
    const sizes = new Map<string, number>();
    for (const n of await fs.readdir(blobDir).catch(() => [] as string[])) {
      const m = n.match(/^([a-f0-9]{64})\.json$/);
      if (m) sizes.set(m[1], (await fs.stat(join(blobDir, n)).catch(() => null))?.size ?? 0);
    }
    return sizes;
  }

  /** Recovery material that is never pruned: the active run's pre-run documents and held conflict versions. */
  private pinnedBlobs(): Set<string> {
    const pinned = new Set<string>();
    for (const c of this.activeRun?.before.values() ?? []) pinned.add(sha(c));
    for (const c of this.pending.values()) if (c !== null) pinned.add(sha(c));
    for (const a of this.attempts.values()) if (a.ref !== null) pinned.add(a.ref);
    return pinned;
  }

  /** Blobs a journal, a run marker or a conflict list on disk names (written by this session or a crash). */
  private async blobsNamedOnDisk(files = [this.local('journal.json'), this.local('sessions', 'active-run.json'), this.local('conflicts.json')]): Promise<Set<string>> {
    const named = new Set<string>();
    for (const f of files) {
      const t = await readIfExists(f);
      if (t) for (const m of t.matchAll(/[a-f0-9]{64}/g)) named.add(m[0]);
    }
    return named;
  }

  private async collectGarbageNow() {
    const blobDir = this.local('history', 'blobs');
    const sizes = await this.blobSizes();
    const pinned = this.pinnedBlobs();
    // Trimmed on a copy, installed only once it is saved: a failed save leaves History as the disk has it, and the
    // versions it names are kept.
    const next: HistoryFile = { ...this.history, entries: [...this.history.entries] };
    const total = () => {
      const all = new Set([...pinned, ...next.entries.flatMap(entryBlobs)]);
      let bytes = 0;
      for (const b of all) bytes += sizes.get(b) ?? 0;
      return bytes;
    };
    let dropped = 0;
    while (next.entries.length > 1 && total() > this.historyByteLimit) {
      // The oldest applied group goes first. With nothing applied, trim redo from its far end instead:
      // dropping the first redo group would leave the next one expecting documents that never return.
      if (next.cursor > 0) {
        noteDropped(next, next.entries.slice(0, 1), 'applied');
        next.entries.shift();
        next.cursor--;
      } else {
        noteDropped(next, next.entries.slice(-1), 'undone');
        next.entries.pop();
      }
      dropped++;
    }
    if (dropped) {
      await atomicWrite(this.local('history', 'history.json'), toJson(next));
      this.history = next;
      this.emit('history');
    }
    const keep = new Set([...pinned, ...this.history.entries.flatMap(entryBlobs), ...(await this.blobsNamedOnDisk())]);
    for (const b of sizes.keys()) if (!keep.has(b)) await fs.rm(join(blobDir, `${b}.json`), { force: true });
    // What a save of a version that stopped part way left, which no version names.
    await this.versions.collect().catch(() => 0);
    await this.gateAssets(() => this.collectAssets());
  }

  /** Delete imported files in static/assets/ that nothing in the project, its retained history or recovery names. */
  private async collectAssets() {
    const inv = await this.assetInventory(this.history, 'sweep');
    if (!inv) return;
    for (const f of inv.files) if (inv.unneeded(f) && Date.now() - f.mtimeMs >= ASSET_GRACE_MS && (await this.sameAssetFile(inv.dir, f))) await fs.rm(join(inv.dir, f.name), { force: true });
  }

  /**
   * Whether `f` is still the very file an inventory saw, in the project's own static/assets/ folder: a file written
   * since (by another app) is new and waits its own turn, and a folder swapped for a link is never deleted from.
   */
  private async sameAssetFile(dir: string, f: AssetFile): Promise<boolean> {
    try {
      if (safeJoin(this.dir, 'static/assets') !== dir || !(await fs.lstat(dir)).isDirectory()) return false;
      const st = await fs.lstat(join(dir, f.name));
      return st.isFile() && st.ino === f.ino && st.size === f.bytes && st.mtimeMs === f.mtimeMs;
    } catch {
      return false;
    }
  }

  /** What each stored version names, by hash and token. Versions never change, so the answers are kept. */
  private mentions = new Map<string, Map<string, boolean>>();
  /** What each project file names, by path and token, for as long as the file stays as it was. */
  private fileMentions = new Map<string, { stamp: string; known: Map<string, boolean> }>();
  private mentionCount = 0;

  /** Count new answers, and start over once there are too many to keep. */
  private noteMentions(n: number) {
    this.mentionCount += n;
    if (this.mentionCount <= MENTION_CACHE_LIMIT) return;
    this.mentions.clear();
    this.fileMentions.clear();
    this.mentionCount = n;
  }

  /**
   * Which of `tokens` the stored version `hash` names. A version that is gone names nothing (nothing can restore it);
   * one that cannot be read is taken to name them all, so that a file it might need is never deleted.
   */
  private async namedIn(hash: string, tokens: string[]): Promise<string[]> {
    let known = this.mentions.get(hash);
    const unknown = tokens.filter((t) => !known?.has(t));
    if (unknown.length) {
      let text: string;
      try {
        text = await this.getBlob(hash);
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === 'ENOENT' ? tokens.filter((t) => known?.get(t)) : tokens;
      }
      this.noteMentions(unknown.length);
      if (!known) {
        known = new Map();
        this.mentions.set(hash, known);
      }
      for (const t of unknown) known.set(t, text.includes(t));
    }
    return tokens.filter((t) => known!.get(t));
  }

  /** Which of `tokens` the project file `rel` holds; null when it could not be read. */
  private async namedInFile(rel: string, tokens: string[]): Promise<string[] | null> {
    const abs = join(this.dir, rel);
    const gone = (e: unknown) => ((e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null);
    let stamp: string;
    try {
      const st = await fs.stat(abs);
      stamp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
    } catch (e) {
      return gone(e);
    }
    let entry = this.fileMentions.get(rel);
    if (entry?.stamp !== stamp) this.fileMentions.set(rel, (entry = { stamp, known: new Map() }));
    const unknown = tokens.filter((t) => !entry!.known.has(t));
    if (unknown.length) {
      let found: Set<string>;
      try {
        found = await searchFile(abs, unknown);
      } catch (e) {
        return gone(e);
      }
      this.noteMentions(unknown.length);
      for (const t of unknown) entry.known.set(t, found.has(t));
    }
    return tokens.filter((t) => entry!.known.get(t));
  }

  /**
   * Which of `tokens` the project names as it is now: any of its documents in memory, the version on disk of a
   * document held in conflict, and any file in the project folder, whatever kind of file it is, except its tools,
   * caches, history and builds (NOT_SEARCHED, NEVER_SEARCHED) and the imported files themselves. Links are not
   * followed, except to the project's own top-level folders. Anything that cannot be read is taken to name them all.
   */
  private async namedNow(tokens: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    const look = (text: string | null) => {
      if (text) for (const t of tokens) if (!found.has(t) && text.includes(t)) found.add(t);
    };
    for (const text of this.docs.values()) look(text);
    // Both sides of a held conflict: the version on disk may be kept, wherever a link puts it.
    for (const p of this.pending.keys()) {
      try {
        look(await fs.readFile(safeJoin(this.dir, p), 'utf8'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return new Set(tokens);
      }
    }
    let complete = true;
    const walk = async (rel: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(join(this.dir, rel), { withFileTypes: true });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') complete = false;
        return;
      }
      for (const e of entries) {
        const open = tokens.filter((t) => !found.has(t));
        if (!complete || !open.length) return;
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory() || (!rel && e.isSymbolicLink() && OWN_FOLDERS.has(e.name))) {
          if (!NEVER_SEARCHED.has(e.name) && !(!rel && NOT_SEARCHED.has(e.name))) await walk(child);
        } else if (e.isFile() && !(rel === 'static/assets' && (IMPORTED_ASSET_RE.test(e.name) || IMPORTED_DOCUMENT_RE.test(e.name)))) {
          const hits = await this.namedInFile(child, open);
          if (hits) hits.forEach((t) => found.add(t));
          else complete = false;
        }
      }
    };
    await walk('');
    return complete ? found : new Set(tokens);
  }

  /**
   * What still needs each file in static/assets/. The project as it is now comes first (its library, and anything
   * in it that names the file: see namedNow), then recovery material (an active run's starting point, held conflict
   * versions), then each history entry, by either side of every document it changed. A sweep (`mode` 'sweep') only
   * asks the project about files nothing else keeps and that are past their grace period.
   */
  private async assetInventory(h: HistoryFile, mode: 'storage' | 'sweep'): Promise<AssetInventory | null> {
    // Only a real folder inside the project is ever looked at, never one a link (at any level) points elsewhere.
    let dir: string;
    try {
      dir = safeJoin(this.dir, 'static/assets');
    } catch {
      return null;
    }
    if (!(await fs.lstat(dir).catch(() => null))?.isDirectory()) return null;
    const now = Date.now();
    const files: AssetFile[] = [];
    for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
      const st = await fs.lstat(join(dir, name)).catch(() => null);
      if (st?.isFile()) files.push({ name, bytes: st.size, mtimeMs: st.mtimeMs, ino: st.ino, token: assetToken(name) });
    }
    // The library names its files outright; only the other imported files need a closer look.
    const library = new Set([...libraryFiles(this.docs.get(ASSETS_DOC)), ...libraryFiles(await this.diskContent(ASSETS_DOC))]);
    const listed = (f: AssetFile) => library.has(`static/assets/${f.name}`);
    const imported = (f: AssetFile) => IMPORTED_ASSET_RE.test(f.name);
    const candidates = files.filter((f) => imported(f) && !listed(f));
    const tokens = [...new Set(candidates.map((f) => f.token))];
    const pinned = new Set<string>();
    const byEntry = h.entries.map(() => new Set<string>());
    let current = new Set<string>();
    if (tokens.length) {
      for (const p of this.attempts.keys()) await this.attemptContent(p);
      const attempted = [...this.attempts.values()].filter((a) => a.ref !== null).map((a) => a.content);
      for (const text of [...(this.activeRun?.before.values() ?? []), ...this.pending.values(), ...attempted]) if (text) for (const t of tokens) if (text.includes(t)) pinned.add(t);
      // A held attempted version that cannot be read now may name any of them: none is taken while it is so.
      if (attempted.includes(undefined)) for (const t of tokens) pinned.add(t);
      // A conflict list or run marker on disk may name versions too.
      for (const b of await this.blobsNamedOnDisk([this.local('sessions', 'active-run.json'), this.local('conflicts.json')])) for (const t of await this.namedIn(b, tokens)) pinned.add(t);
      for (const [i, e] of h.entries.entries()) for (const b of entryBlobs(e)) for (const t of await this.namedIn(b, tokens)) byEntry[i].add(t);
      const kept = (t: string) => pinned.has(t) || byEntry.some((s) => s.has(t));
      const ask = mode === 'storage' ? tokens : [...new Set(candidates.filter((f) => !kept(f.token) && now - f.mtimeMs >= ASSET_GRACE_MS).map((f) => f.token))];
      if (ask.length) current = await this.namedNow(ask);
    }
    const inHistory = (t: string) => byEntry.some((s) => s.has(t));
    const inUse = (f: AssetFile) => listed(f) || current.has(f.token);
    // A sweep never takes a file in its grace period, nor one whose token it did not ask the project about.
    const due = (f: AssetFile) => mode === 'storage' || now - f.mtimeMs >= ASSET_GRACE_MS;
    return { dir, files, pinned, byEntry, inUse, unneeded: (f) => imported(f) && due(f) && !inUse(f) && !pinned.has(f.token) && !inHistory(f.token) };
  }

  /** Why space cannot be freed now, if so. */
  private reclaimBlocked(): string | undefined {
    if (this.readOnly) return this.readOnly.reason;
    if (this.unsettled || this.migrationFailed) return UNSETTLED;
    if (this.activeRun) return 'Wait for the AI to finish, then try again.';
    if (this.pending.size) return 'Resolve the file conflicts in Project health first.';
    return undefined;
  }

  /**
   * What the project's media and history take on disk, and what freeing up space would do. Removed files kept only
   * for history can go once the history steps that name them are dropped. Steps are dropped from the ends only (the
   * oldest undo steps up to the newest one naming such a file, and the furthest redo steps back to the nearest one),
   * as the byte cap prunes, so every step that stays still undoes and redoes as before.
   */
  private async storagePlan(h: HistoryFile): Promise<{ info: StorageInfo; drop: { dir: string; from: number; to: number; files: AssetFile[]; blobs: Map<string, number> } | null }> {
    const inv = await this.assetInventory(h, 'storage');
    const sizes = await this.blobSizes();
    const media = { files: 0, bytes: 0 };
    const kept = { files: 0, bytes: 0 };
    const freeable: AssetFile[] = [];
    for (const f of inv?.files ?? []) {
      if (inv!.inUse(f)) {
        media.files++;
        media.bytes += f.bytes;
        continue;
      }
      if (!IMPORTED_ASSET_RE.test(f.name)) continue;
      const inHistory = inv!.byEntry.some((s) => s.has(f.token));
      if (!inHistory && !inv!.pinned.has(f.token)) continue;
      kept.files++;
      kept.bytes += f.bytes;
      if (inHistory && !inv!.pinned.has(f.token)) freeable.push(f);
    }
    const sum = (blobs: Iterable<string>) => [...new Set(blobs)].reduce((n, b) => n + (sizes.get(b) ?? 0), 0);
    const info: StorageInfo = {
      media,
      kept,
      history: { steps: h.entries.length, bytes: sum(h.entries.flatMap(entryBlobs)) },
      versions: { count: this.versions.versions.length, bytes: this.versions.totalBytes(), ...(this.versions.historyBytes() ? { historyBytes: this.versions.historyBytes() } : {}) },
      reclaim: null,
      blocked: this.reclaimBlocked()
    };
    if (!inv || !freeable.length) return { info, drop: null };
    const tokens = new Set(freeable.map((f) => f.token));
    const names = (i: number) => [...tokens].some((t) => inv.byEntry[i].has(t));
    let from = 0;
    for (let i = h.cursor - 1; i >= 0; i--)
      if (names(i)) {
        from = i + 1;
        break;
      }
    let to = h.entries.length;
    for (let i = h.cursor; i < h.entries.length; i++)
      if (names(i)) {
        to = i;
        break;
      }
    const stays = new Set([...this.pinnedBlobs(), ...h.entries.slice(from, to).flatMap(entryBlobs), ...(await this.blobsNamedOnDisk())]);
    const blobs = new Map<string, number>();
    for (const e of [...h.entries.slice(0, from), ...h.entries.slice(to)]) for (const b of entryBlobs(e)) if (!stays.has(b) && sizes.has(b)) blobs.set(b, sizes.get(b)!);
    const undo = h.entries.slice(0, from);
    const redo = h.entries.slice(to);
    // Everything the author is shown, so a reclaim confirmed for one plan never carries out another.
    const key = sha(JSON.stringify({ cursor: h.cursor, undo: undo.map((e) => [e.id, e.docs]), redo: redo.map((e) => [e.id, e.docs]), files: freeable.map((f) => [f.name, f.bytes]).sort(), blobs: [...blobs].sort() }));
    info.reclaim = {
      key,
      files: { files: freeable.length, bytes: freeable.reduce((n, f) => n + f.bytes, 0) },
      historyBytes: [...blobs.values()].reduce((a, b) => a + b, 0),
      undo: undo.map((e) => e.label),
      redo: redo.map((e) => e.label),
      keptUndo: h.cursor - from,
      keptRedo: to - h.cursor
    };
    return { info, drop: { dir: inv.dir, from, to, files: freeable, blobs } };
  }

  /**
   * What the project's media and history take on disk (see storagePlan). It only reads, outside the queue of writes so
   * it never holds up a save, from a copy of history taken as it starts; reclaimStorage checks the plan again in turn.
   */
  async storageInfo(): Promise<StorageInfo> {
    return (await this.storagePlan({ ...this.history, entries: [...this.history.entries] })).info;
  }

  /**
   * Free the space storageInfo offered under `key`: drop the history steps it named, then delete the removed files
   * and history versions only they used. The shorter history is saved before anything is deleted, so a step that
   * stays never needs a file that is gone. Refused, changing nothing, when the plan no longer matches the project.
   */
  reclaimStorage(key: string): Promise<{ ok: boolean; message?: string; freed?: number }> {
    return this.serialize(async () => {
      const blocked = await this.writeBlocked();
      if (blocked) return { ok: false, message: blocked.error?.message };
      const why = this.reclaimBlocked();
      if (why) return { ok: false, message: why };
      const done = await this.gateAssets(async () => {
        const { drop, info } = await this.storagePlan(this.history);
        if (!drop || info.reclaim?.key !== key) return { ok: false, message: 'The project changed since the space was worked out. Check what will be freed, then try again.' };
        const h = this.history;
        const next: HistoryFile = { ...h, entries: h.entries.slice(drop.from, drop.to), cursor: h.cursor - drop.from };
        noteDropped(next, h.entries.slice(0, drop.from), 'applied');
        noteDropped(next, h.entries.slice(drop.to), 'undone');
        await atomicWrite(this.local('history', 'history.json'), toJson(next));
        this.history = next;
        this.emit('history');
        // Another app may have saved a file naming one of them while the plan was worked out: that file stays.
        const named = await this.namedNow([...new Set(drop.files.map((f) => f.token))]);
        let freed = 0;
        let failed = 0;
        const remove = async (path: string, bytes: number) => {
          try {
            await fs.rm(path);
            freed += bytes;
          } catch (e) {
            // Gone already is as good as deleted; anything else is left for a later sweep, which finds it unneeded.
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') failed++;
          }
        };
        for (const f of drop.files) if (!named.has(f.token) && (await this.sameAssetFile(drop.dir, f))) await remove(join(drop.dir, f.name), f.bytes);
        for (const [b, bytes] of drop.blobs) await remove(this.local('history', 'blobs', `${b}.json`), bytes);
        return { ok: true, freed, ...(failed ? { message: `${failed === 1 ? 'One file' : `${failed} files`} could not be deleted yet. ${failed === 1 ? 'It is' : 'They are'} removed automatically later.` } : {}) };
      });
      return done ?? { ok: false, message: 'Wait for the files being added to finish, then try again.' };
    });
  }

  historyInfo() {
    const h = this.history;
    return {
      canUndo: h.cursor > 0 && !this.activeRun,
      canRedo: h.cursor < h.entries.length && !this.activeRun,
      undoLabel: h.entries[h.cursor - 1]?.label,
      redoLabel: h.entries[h.cursor]?.label,
      entries: h.entries.map((e, i) => ({ id: e.id, label: e.label, source: e.source, time: e.time, revision: e.revision, applied: i < h.cursor, runId: e.runId, ...(e.revertsRunId ? { revertsRunId: e.revertsRunId } : {}), ...(e.guestName ? { guestName: e.guestName } : {}) })),
      ...(h.droppedRuns ? { droppedRuns: { ...h.droppedRuns } } : {})
    };
  }

  // -------------------------------------------------------------------------
  // Saved versions (issue 260)
  // -------------------------------------------------------------------------

  /** What `versionsInfo` last said, and the list, problem and sizes it said it of. */
  private versionsShown: { store: VersionStore; versions: readonly SavedVersion[]; problem: string | null; sizes: number; info: VersionsInfo } | null = null;

  /**
   * The saved versions, newest first, with what each one alone takes on disk. Every snapshot shows them, and an edit
   * changes none of it: worked out again only once the list, its problem or a stored object's size changed.
   */
  versionsInfo(): VersionsInfo {
    const store = this.versions;
    const shown = this.versionsShown;
    if (shown && shown.store === store && shown.versions === store.versions && shown.problem === store.problem && shown.sizes === store.sizesChanged) return shown.info;
    const timing = perf.span('session.versionsInfo', { versions: store.versions.length });
    const info: VersionsInfo = {
      list: [...store.versions].reverse().map((v) => ({
        id: v.id,
        name: v.name,
        time: v.time,
        auto: !!v.auto,
        ...(v.restored ? { restored: true } : {}),
        pages: Object.keys(v.docs).filter((p) => PAGE_DOC.test(p)).length,
        bytes: store.exclusiveBytes(v),
        missing: Object.keys(v.media).filter((p) => v.media[p] === null)
      })),
      bytes: store.totalBytes(),
      ...(store.historyBytes() ? { historyBytes: store.historyBytes() } : {}),
      ...(store.problem ? { problem: store.problem } : {})
    };
    timing();
    this.versionsShown = { store, versions: store.versions, problem: store.problem, sizes: store.sizesChanged, info };
    return info;
  }

  /** Why a version can't be saved or restored now, if so. */
  private async versionsBlocked(): Promise<string | null> {
    const blocked = await this.writeBlocked();
    if (blocked) return blocked.error?.message ?? LOCK_UNCHECKED;
    // The documents hold the AI's provisional work while it runs.
    if (this.activeRun) return 'Wait for the AI to finish, then try again.';
    return this.versions.problem;
  }

  /**
   * The media files a version of `docs` holds: every file the asset library lists (originals and smaller copies), and
   * every other public file under static/ that a document names. A file directly in static/assets/ is named as the
   * sweep finds it, an imported one by its eight hash characters and any other by its whole name (a code component's
   * /assets/logo.svg); one anywhere else by its address on the site (/brand/logo.svg, or /brand/My%20Logo.svg).
   * Generated and private files are never held (see heldAsMedia).
   */
  private async versionMediaPaths(docs: Map<string, string>): Promise<string[]> {
    const out = new Set(libraryFiles(docs.get(ASSETS_DOC)).filter(heldAsMedia));
    let root: string;
    try {
      root = safeJoin(this.dir, 'static');
    } catch {
      return [...out].sort();
    }
    // The brief is the author's own notes: a file it names is not one the site uses.
    const texts = [...docs].filter(([p]) => p !== BRIEF_FILE).map(([p, t]) => (p === ASSETS_DOC ? withoutOriginalNames(t) : t));
    const byAddress = (rel: string) => {
      const address = rel.slice('static'.length);
      const encoded = encodeURI(address);
      return texts.some((t) => namesFile(t, address) || (encoded !== address && namesFile(t, encoded)));
    };
    const consider = async (abs: string, rel: string, name: string) => {
      if (out.has(rel) || !heldAsMedia(rel) || this.generated.files[rel]) return;
      const named =
        rel === `static/assets/${name}` ? (IMPORTED_ASSET_RE.test(name) ? texts.some((t) => t.includes(assetToken(name))) : texts.some((t) => namesFile(t, name)) || byAddress(rel)) : byAddress(rel);
      // A link it names is held as missing, so the author is told rather than the file left out unseen. Folders aren't files.
      const st = named ? await fs.lstat(abs).catch(() => null) : null;
      if (st && !st.isDirectory()) out.add(rel);
    };
    const entries = async (dir: string) => ((await fs.lstat(dir).catch(() => null))?.isDirectory() ? await fs.readdir(dir).catch(() => [] as string[]) : []);
    // static/assets/, where the app keeps media, always in full; then the rest of static/, through real folders only,
    // up to a generous number of entries, so a huge folder of other files can't hold a save up.
    for (const name of await entries(join(root, 'assets'))) if (!name.startsWith('.')) await consider(join(root, 'assets', name), `static/assets/${name}`, name);
    let budget = 20_000;
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      for (const name of await entries(dir)) {
        if (name.startsWith('.') || --budget < 0) continue;
        const childRel = `${rel}/${name}`;
        const abs = join(dir, name);
        const st = await fs.lstat(abs).catch(() => null);
        if (st?.isDirectory()) {
          if (depth < 12) await walk(abs, childRel, depth + 1);
        } else if (st && !st.isDirectory() && childRel !== `static/assets/${name}`) await consider(abs, childRel, name);
      }
    };
    await walk(root, 'static', 0);
    return [...out].sort();
  }

  /**
   * Store the project as it is now, its documents and the media they name (and `also`, files a restore is about to put
   * something else in), as a version not yet in the list. A file that is not there, or is a link, is kept as missing;
   * one that could not be read stops the save.
   */
  private async captureVersion(name: string, opts: CaptureOptions = {}): Promise<SavedVersion> {
    await this.versions.checkFolders();
    // Asked once per version: the same Git decides and stores it. `plain` keeps it to this store whatever the setting.
    const git = opts.plain ? null : versionsGit();
    if (git && (await git.enabled())) return this.captureGitVersion(git, name, opts);
    const docs: Record<string, string> = {};
    // A version is of the site: the brief says what the project is for, and a restore keeps the one it has.
    // Nor what has been published: a restore never takes back what the website was exported with.
    for (const [path, content] of this.docs) {
      if (path === BRIEF_FILE || path === PUBLISHED_FILE) continue;
      stopIf(opts.stop);
      docs[path] = await this.versions.putText(content);
    }
    const media: Record<string, string | null> = {};
    for (const rel of new Set([...(await this.versionMediaPaths(this.docs)), ...(opts.also ?? [])])) {
      stopIf(opts.stop);
      let abs: string;
      try {
        abs = safeJoin(this.dir, rel);
      } catch {
        // Reached through a link out of the project: not the project's own file, so held as missing.
        media[rel] = null;
        continue;
      }
      try {
        const st = await fs.lstat(abs);
        media[rel] = st.isFile() ? await this.versions.putFile(abs) : null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${rel} could not be read, so nothing was saved: ${(e as Error).message}`);
        media[rel] = null;
      }
    }
    const filled = opts.filled && Object.keys(opts.filled).length ? { filled: opts.filled } : {};
    return { id: newVersionId(), name, time: new Date().toISOString(), revision: this.revision, schemaVersion: SCHEMA_VERSION, ...(opts.auto ? { auto: true } : {}), docs, media, ...filled };
  }

  /**
   * captureVersion with Git snapshots on (#1153): the whole site (snapshot-inventory.ts) written as a tree and a commit
   * of it on the versions branch's tip, the branch not moved yet (VersionStore.add moves it). The documents are the
   * loaded ones, as for any version, so what the row records is what the tree holds; external sources' settings and
   * converters are objects of the list's store instead, never in Git, as is a file the site names that a snapshot
   * leaves out (a private name, a file of a nested repository). The media a restore puts back are recorded as ever, by
   * their SHA-256, and the worker stores each file only while it still holds the bytes hashed.
   */
  private async captureGitVersion(git: VersionsGit, name: string, opts: CaptureOptions): Promise<SavedVersion> {
    // A restore's version takes the ID its restore noted first, so a stop is matched with the restore it belongs to.
    const id = opts.restored?.id ?? newVersionId();
    const time = new Date().toISOString();
    const docs: Record<string, string> = {};
    const files: FileInput[] = [];
    const inline = new Set<string>();
    for (const [path, content] of this.docs) {
      if (path === BRIEF_FILE || path === PUBLISHED_FILE) continue;
      if (keptOutOfGit(path)) docs[path] = await this.versions.putText(content);
      else {
        const bytes = Buffer.from(content, 'utf8');
        docs[path] = sha(bytes);
        files.push({ path, bytes });
        inline.add(path);
      }
    }
    let inventory: Awaited<ReturnType<typeof captureSnapshotInventory>>;
    try {
      inventory = await captureSnapshotInventory(this.dir, { settleMs: this.settleMs, ...(opts.stop ? { paused: () => stopIf(opts.stop), stop: opts.stop } : {}) });
    } catch (e) {
      if (e instanceof CaptureStopped || opts.stop?.()) throw new CaptureStopped();
      throw new Error(`${(e as Error).message} Nothing was saved.`);
    }
    // Every other file of the site, as it is on disk (the record of what was published, and code no component claims,
    // included); the documents on disk are the loaded ones, checked before saving.
    const hashed = new Map<string, string>();
    // A document loaded under another spelling of a file's name is that file, where the disk ignores case: the same
    // file under both names. Two files whose names differ only so are two, and the worker refuses the clash.
    const folded = (p: string) => p.split('/').map(foldName).join('/');
    const inlineNames = new Map([...inline].map((p) => [folded(p), p]));
    const sameFile = async (a: string, b: string) => {
      const [x, y] = await Promise.all([a, b].map((p) => fs.stat(join(this.dir, p), { bigint: true }).catch(() => null)));
      return !!x && !!y && x.dev === y.dev && x.ino === y.ino;
    };
    for (const f of inventory.tree) {
      const loaded = inlineNames.get(folded(f.path));
      if (loaded === f.path || (loaded !== undefined && (await sameFile(loaded, f.path)))) continue;
      hashed.set(f.path, f.sha256);
      files.push({ path: f.path, source: f.path, sha256: f.sha256, mode: f.mode });
    }
    if (opts.hashes) for (const [p, h] of hashed) opts.hashes.set(p, h);
    const outside: string[] = [];
    const media: Record<string, string | null> = {};
    for (const rel of new Set([...(await this.versionMediaPaths(this.docs)), ...(opts.also ?? [])])) {
      let abs: string;
      try {
        abs = safeJoin(this.dir, rel);
      } catch {
        media[rel] = null;
        continue;
      }
      let st: Stats;
      try {
        st = await fs.lstat(abs);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${rel} could not be read, so nothing was saved: ${(e as Error).message}`);
        media[rel] = null;
        continue;
      }
      if (!st.isFile()) {
        media[rel] = null;
        continue;
      }
      const h = hashed.get(rel);
      if (h) {
        media[rel] = h;
        continue;
      }
      // A file the site names that a snapshot leaves out (a private name, a nested repository's, another spelling of a
      // file on a disk that ignores case): held as it always was, an object beside the list, and never in history.
      stopIf(opts.stop);
      media[rel] = await this.versions.putFile(abs);
      outside.push(rel);
    }
    stopIf(opts.stop);
    let stored: { commit: string; tree: string };
    try {
      stored = await writeVersionCommit(git.repository(this.dir), files, id, time, opts.restored ? 'restored' : opts.auto ? 'auto' : 'saved', opts.signal ? { signal: opts.signal } : {});
    } catch (e) {
      if (opts.stop?.()) throw new CaptureStopped();
      if (e instanceof GitError && e.code === 'corrupt') throw new HistoryDamaged(gitSaveProblem(e));
      throw new Error(gitSaveProblem(e));
    } finally {
      // Whatever was written counts from now, whether this version is listed or not.
      await this.versions.measureGit();
    }
    const filled = opts.filled && Object.keys(opts.filled).length ? { filled: opts.filled } : {};
    const made = opts.restored ? { auto: true, restored: true } : opts.auto ? { auto: true } : {};
    return { id, name, time, revision: this.revision, schemaVersion: SCHEMA_VERSION, ...made, docs, media, ...filled, git: { ...stored, ...(outside.length ? { outside: outside.sort() } : {}) } };
  }

  /**
   * Save the site as it is now as a named version, kept until the author deletes it. A file its documents name that
   * is missing from the folder does not stop the save: it is listed in `missing`, and the version records it as such.
   */
  saveVersion(name: string): Promise<{ ok: boolean; message?: string; id?: string; name?: string; missing?: string[] }> {
    return this.serialize(async () => this.storeVersion(name, await this.versionsBlocked()));
  }

  /**
   * Save a named version for the AI request `runId`, which the author asked for (#1406). Only a run that has changed
   * nothing can: its documents are then the author's own, settled, and the version holds no provisional work. A
   * version is no change to the site, so the run keeps the project and may go on to change it.
   */
  saveVersionForRun(runId: string, name: string): Promise<{ ok: boolean; message?: string; id?: string; name?: string; missing?: string[] }> {
    return this.serialize(async () => {
      const run = this.activeRun;
      if (!run || run.id !== runId) return { ok: false, message: 'This request no longer holds the project.' };
      if (this.runChanged() || this.revision !== run.startRevision) return { ok: false, message: 'This request has already changed the site, so a version saved now would hold its unfinished changes. Nothing was saved: the author can save it from History, Versions, once this request finishes.' };
      const blocked = await this.writeBlocked();
      return this.storeVersion(name, blocked ? (blocked.error?.message ?? LOCK_UNCHECKED) : this.versions.problem);
    });
  }

  /** saveVersion's work, run inside serialize once `why` (what stops a version being saved now, if anything) is known. */
  private async storeVersion(name: string, why: string | null): Promise<{ ok: boolean; message?: string; id?: string; name?: string; missing?: string[] }> {
    why ??= await this.pendingVersionBlocks();
    if (why) return { ok: false, message: why };
    const clean = name.replace(/\s+/g, ' ').trim();
    if (!clean) return { ok: false, message: 'Give the version a name.' };
    if (clean.length > VERSION_NAME_MAX) return { ok: false, message: `Use a name of at most ${VERSION_NAME_MAX} characters.` };
    // A change made outside the app and not loaded yet would be missing from it, under the author's chosen name.
    const unloaded = await this.unloadedEdit(new Set());
    if (unloaded) return { ok: false, message: `${unloaded} changed outside the app. Try again in a moment.` };
    let v: SavedVersion;
    try {
      v = await this.captureVersion(clean);
      // Storing a large library takes a while: something may have changed outside the app meanwhile, or an Unlock
      // from another app taken the project over.
      const late = await this.unloadedEdit(new Set());
      if (late) return { ok: false, message: `${late} changed outside the app. Try again in a moment.` };
      if (!(await this.stillOwner())) return { ok: false, message: this.readOnly?.reason ?? LOCK_UNCHECKED };
      v = await this.versions.add(v);
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    this.emit('history');
    return { ok: true, id: v.id, name: clean, missing: Object.keys(v.media).filter((p) => v.media[p] === null) };
  }

  /**
   * captureVersion for a version the app saves by itself. With the version history damaged it is saved in the plain
   * store instead, so a safety version is still there to go back to.
   */
  private captureAuto(name: string, opts: Omit<CaptureOptions, 'auto' | 'plain'> = {}): Promise<SavedVersion> {
    return this.captureVersion(name, { ...opts, auto: true }).catch((e: unknown) => (e instanceof HistoryDamaged ? this.captureVersion(name, { ...opts, auto: true, plain: true }) : Promise.reject(e)));
  }

  /**
   * List `v`, a version the app captured by itself, unless one listed already holds exactly what it does (with `name`,
   * one by that name): that one stands for it. Gives back the row that does. Run in turn with every other command.
   */
  private async listAuto(v: SavedVersion, name?: string, stop?: () => boolean): Promise<SavedVersion> {
    const kept = await this.versions.sameAs(v, name);
    // Capturing (and reading a version's commit back) takes a while: another app may have taken the project over
    // meanwhile, which a version kept as it is must not hide from what follows (a theme switch's save).
    if (!(await this.stillOwner())) throw new Error(this.readOnly?.reason ?? LOCK_UNCHECKED);
    stopIf(stop);
    if (kept) return kept;
    // The version of a restore still being recorded (#1155) goes first, as before any version saved: this one builds on it.
    if (v.git) {
      const pending = await this.pendingVersionBlocks();
      if (pending) throw new Error(pending);
    }
    const row = await this.versions.add(v);
    this.emit('history');
    return row;
  }

  /** Set by close: a starting version not begun by then is never saved, and one being saved stops. */
  private leaving = false;
  private leavingAbort = new AbortController();

  /**
   * Save the "Starting version" (#1156) of a project that has never had a version saved: a new project once it is
   * created, locked and generated, or an existing one on its first writable opening. A project with a list of versions
   * (even one whose versions were all deleted) gets none, so reopening never adds another. Queued in turn with every
   * other command, so it holds the project as it was opened, ahead of any edit. A failure leaves the project as usable
   * as ever, with a notice saying so; the next opening tries again. Gives back whether one was saved.
   */
  recordStartingVersion(): Promise<boolean> {
    return this.serialize(async () => {
      if (this.leaving || this.readOnly || this.versions.listed || this.versions.problem) return false;
      // Only a project in a settled state, as an edit would find it: never one waiting for a format update, a save to
      // finish on reopening, or a choice between versions of a file.
      if (this.unsettled || this.migrationDue || this.migrationFailed || this.pending.size || this.conflicts.length || this.activeRun) return false;
      if (await this.writeBlocked()) return false;
      try {
        // A change outside the app not loaded yet: the next opening saves it, loaded.
        if (await this.unloadedEdit(new Set())) return false;
        const v = await this.captureAuto(STARTING_VERSION, { stop: () => this.leaving, signal: this.leavingAbort.signal });
        if (this.leaving) return false;
        const late = await this.unloadedEdit(new Set());
        if (late || this.leaving) return false;
        await this.listAuto(v, undefined, () => this.leaving);
        return true;
      } catch (e) {
        if (this.leaving || e instanceof CaptureStopped) return false;
        this.recoveryNotes.push(`The starting version of this project could not be saved, so it isn’t in History yet: ${(e as Error).message} Your project is fine to work on, and you can save a version yourself under Saved versions.`);
        this.emit('history');
        return false;
      }
    });
  }

  /**
   * Capture the project as it is now as a version an export can list once it is delivered (#1156), not listed yet:
   * collection keeps what it holds until `release` is called. Run within the export's hold of the project, so it is
   * the project the export copies.
   */
  async captureExported(name: string): Promise<ExportedVersion | { changed: string }> {
    // Written to the project's own store, so under the lock generation's claim, as any write of a command is; the
    // export's hold of the project is otherwise only a turn in the queue.
    return this.fenced(async () => {
      const why = await this.versionsBlocked();
      if (why) throw new Error(why);
      // A document changed outside the app and not loaded yet would be exported as the folder has it, and saved as the
      // app does: the export waits for it instead. The brief and the record of what was published are never a version's.
      const changed = await this.unloadedEdit(new Set([BRIEF_FILE, PUBLISHED_FILE]));
      if (changed) return { changed };
      const files = new Map<string, string>();
      const version = await this.captureAuto(name, { hashes: files });
      return { version, release: this.versions.hold(version), files };
    });
  }

  /**
   * List the version an export captured (captureExported) now that it is delivered, unless one by its name already
   * holds exactly that. Gives back the row standing for it.
   */
  listExported(v: SavedVersion): Promise<SavedVersion> {
    return this.serialize(async () => {
      // Captured before any AI request that began since: listing it saves none of that request's work.
      const blocked = await this.writeBlocked();
      if (blocked) throw new Error(blocked.error?.message ?? LOCK_UNCHECKED);
      if (this.versions.problem) throw new Error(this.versions.problem);
      return this.listAuto(v, v.name);
    });
  }

  /**
   * What restoring `v` leaves: the project it holds, brought up to the current format if it is older, with this
   * project's own manifest (its identity stays, whichever version of the site it holds), and the files to put back.
   * Every object it needs is read and checked, and the project it leaves validated, before anything is written.
   */
  private async restorePlan(v: SavedVersion): Promise<{ ok: false; message: string } | { ok: true; state: ProjectState; docs: Map<string, string>; files: Array<{ path: string; hash: string; replaces: boolean }>; left: string[]; others: string[] }> {
    const refuse = (message: string) => ({ ok: false as const, message });
    if (v.schemaVersion > SCHEMA_VERSION) return refuse(`“${v.name}” was saved by a newer version of SiteOrigin Builder. Update the app to restore it.`);
    const stored = new Map<string, string>();
    try {
      // A version never holds the brief; one that does (saved before that was so) is restored without it.
      for (const [path, h] of Object.entries(v.docs)) if (path !== BRIEF_FILE && path !== PUBLISHED_FILE) stored.set(path, (await this.versions.readFile(v, path, h)).toString('utf8'));
    } catch (e) {
      return refuse((e as Error).message);
    }
    let state: ProjectState;
    try {
      const read = await readProject(this.dir, { only: stored });
      // The brief stays too: it says what the project is for, whichever version of the site it holds.
      state = { ...read.state, manifest: this.state.manifest };
      if (this.state.brief) state.brief = this.state.brief;
      else delete state.brief;
      // So does the record of what was exported, which no version of the site takes back.
      if (this.state.published) state.published = this.state.published;
      else delete state.published;
    } catch (e) {
      return refuse(`“${v.name}” can’t be restored: ${(e as Error).message}`);
    }
    // Reading fills a component's missing code with nothing: a version without it is damaged, not empty.
    for (const def of Object.values(state.components)) if (def.sourcePath && !stored.has(def.sourcePath)) return refuse(VERSION_DAMAGED);
    const fatal = validateState(state, { sectionLinks: false }).find((d) => d.severity === 'error' && FATAL_CODES.has(d.code));
    if (fatal) return refuse(`“${v.name}” can’t be restored: ${fatal.message}`);
    const resolve = componentSources(state.components);
    for (const def of Object.values(state.components)) {
      if (def.kind !== 'code' || def.source === undefined || def.source === this.state.components[def.id]?.source) continue;
      if (def.owner === 'theme' && listThemes().some((t) => t.components.some((c) => c.id === def.id && c.source === def.source))) continue;
      const bad = (await checkSvelteSource(def.source, { filename: def.sourcePath, resolve })).filter((p) => p.severity === 'error');
      if (bad.length) return refuse(`The code for “${def.name}” in “${v.name}” has problems, so it can’t be restored: ${bad[0].message}`);
    }
    const files: Array<{ path: string; hash: string; replaces: boolean }> = [];
    for (const [path, h] of Object.entries(v.media)) {
      if (h === null || !heldAsMedia(path) || this.generated.files[path]) continue;
      let abs: string;
      try {
        abs = safeJoin(this.dir, path);
      } catch (e) {
        return refuse(`“${v.name}” can’t put back ${path}: ${(e as Error).message}`);
      }
      const st = await fs.lstat(abs).catch(() => null);
      if (st && !st.isFile()) return refuse(`${path} is not a file, so “${v.name}” can’t put back its own.`);
      if (st && sha(await fs.readFile(abs)) === h) continue;
      // Never through a link inside the project, which could lead into its own `.git` or `.siteorigin`.
      if (await linkOnTheWay(this.dir, path)) return refuse(`${path} is reached through a link, so “${v.name}” can’t put it back.`);
      try {
        await this.versions.readFile(v, path, h);
      } catch (e) {
        return refuse((e as Error).message);
      }
      files.push({ path, hash: h, replaces: !!st });
    }
    // Files the restore that saved this version put where none were, still as it left them: restoring this leaves them.
    const left: string[] = [];
    for (const [path, h] of Object.entries(v.filled ?? {})) {
      if (v.media[path]) continue;
      const abs = safeJoin(this.dir, path);
      if ((await fs.lstat(abs).catch(() => null))?.isFile() && sha(await fs.readFile(abs)) === h) left.push(path);
    }
    const docs = stateToDocs(state);
    let others: string[] = [];
    if (v.git) {
      try {
        others = await this.otherFiles(v, docs, docs.size !== this.docs.size || [...docs].some(([p, c]) => this.docs.get(p) !== c));
      } catch (e) {
        return refuse((e as Error).message);
      }
    }
    return { ok: true, state, docs, files, left, others };
  }

  /**
   * The files of the site a restore of `v`, a version in Git, doesn't copy from it that differ from what the project
   * folder holds now (#1396): the code, setup and public files besides Builder's documents and the media they name. A
   * file counts where either side holds it as written by hand, not by the generator (each side's record of what it
   * generated says which of its files were): generated output follows the documents restored, and the media a restore
   * puts back are reviewed as ever. Compared by Git's name for the bytes, so only a file both sides hold is read.
   * `docs` are the documents the restore leaves; `retires`, whether they differ from the project's, so the generator
   * may rewrite or remove a file it writes now.
   */
  private async otherFiles(v: SavedVersion, docs: Map<string, string>, retires: boolean): Promise<string[]> {
    const saved = await this.versions.gitFiles(v);
    const now = new Map((await listSnapshotFiles(this.dir)).map((f) => [f.path, f]));
    // Builder's own: the documents on every side, the media the version holds and either side's library.
    const builders = new Set([...docs.keys(), ...this.docs.keys(), ...Object.keys(v.docs), ...Object.keys(v.media), ...libraryFiles(docs.get(ASSETS_DOC)), ...libraryFiles(this.docs.get(ASSETS_DOC))]);
    // A project open read-only never loaded the generator's record: it is read for this (never waiting on a pipe), and
    // nothing written.
    const current = this.readOnly ? claimedFiles((await readTextAt(join(this.dir, GENERATED_MANIFEST)))?.text) : [...Object.keys(this.generated.files), ...Object.keys(this.generated.pending ?? {})];
    const generatedNow = new Set(current);
    const generatedThen = new Set(saved.generated);
    // A file listed under another spelling of a name Builder knows it by, where the disk ignores case, is that file (as
    // captureGitVersion finds a document): the same entry, never through a link. Two files whose names differ only so are two.
    const folded = (p: string) => p.split('/').map(foldName).join('/');
    const known = new Map([...builders, ...generatedNow].map((p) => [folded(p), p]));
    const sameEntry = async (a: string, b: string) => {
      const [x, y] = await Promise.all([a, b].map((p) => fs.lstat(join(this.dir, p), { bigint: true }).catch(() => null)));
      return !!x && !!y && x.dev === y.dev && x.ino === y.ino;
    };
    const out: string[] = [];
    for (const path of new Set([...saved.files.keys(), ...now.keys()])) {
      if (path === MANIFEST_FILE || path.startsWith('siteorigin/') || builders.has(path)) continue;
      const was = saved.files.get(path);
      const is = now.get(path);
      const alias = is && !generatedNow.has(path) ? known.get(folded(path)) : undefined;
      const aliased = alias !== undefined && alias !== path && (await sameEntry(alias, path));
      // Builder's own file under the disk's spelling: a document or a media file, which a restore puts back by its own
      // spelling, or generated output where the version has nothing by this spelling either.
      if (aliased && (!was || builders.has(alias))) continue;
      // Whether the file at this path now is Builder's: its generated output, or a file it knows by another spelling.
      const buildersNow = !!is && (generatedNow.has(path) || aliased);
      const byHandThen = !!was && !generatedThen.has(path);
      if (!byHandThen && !(is && !buildersNow)) continue;
      // The version's own copy of a file Builder has taken over since: with other documents restored, the generator may
      // rewrite or remove it, and the version's copy isn't put back, however alike the two are now.
      const retired = retires && byHandThen && buildersNow;
      // Git's mode says whether a file runs, which Windows doesn't keep: there only the bytes are compared. A file too
      // large for a snapshot is none the version could hold, so it is never read.
      if (!retired && was && is && is.size <= MAX_SNAPSHOT_FILE && (process.platform === 'win32' || (was.mode === '100755') === is.executable) && (await is.blobOid()) === was.oid) continue;
      out.push(path);
    }
    return out.sort();
  }

  /** What restoring saved version `id` would change in the project as it is now. Changes nothing. */
  reviewVersion(id: string): Promise<{ ok: boolean; message?: string; review?: VersionReview }> {
    // Queued behind any save, so it compares with a settled project, but it never writes.
    return this.serialize(async () => {
      const v = this.versions.versions.find((x) => x.id === id);
      if (!v) return { ok: false, message: 'That saved version is no longer there.' };
      const review: VersionReview = {
        revision: this.revision,
        pages: { back: [], gone: [], changed: [] },
        entries: { back: [], gone: [], changed: [] },
        collections: { back: [], gone: [], changed: [] },
        site: false,
        styles: false,
        components: 0,
        library: false,
        files: [],
        replaced: [],
        left: [],
        others: [],
        missing: Object.keys(v.media).filter((p) => v.media[p] === null),
        unchanged: false
      };
      const plan = await this.restorePlan(v);
      if (!plan.ok) return { ok: true, review: { ...review, problem: plan.message } };
      const title = (s: ProjectState, pageId: string) => s.pages[pageId]?.title?.trim() || 'Untitled page';
      let differs = false;
      for (const p of new Set([...plan.docs.keys(), ...this.docs.keys()])) {
        if (plan.docs.get(p) === this.docs.get(p)) continue;
        differs = true;
        const pageId = p.match(PAGE_DOC)?.[1];
        if (pageId) {
          if (!this.docs.has(p)) review.pages.back.push(title(plan.state, pageId));
          else if (!plan.docs.has(p)) review.pages.gone.push(title(this.state, pageId));
          else review.pages.changed.push(title(plan.state, pageId));
        } else if (collectionPathOf(p)) {
          const at = collectionPathOf(p)!;
          const text = (v: unknown, fallback: string) => (typeof v === 'string' && v.trim() ? v.trim() : fallback);
          const name = (s: ProjectState) => text(s.collections[at.collectionId]?.settings.name, at.collectionId);
          const entry = (s: ProjectState) => text(s.collections[at.collectionId]?.entries[at.entryId!]?.title, 'Untitled entry');
          if (at.entryId === undefined) {
            if (!this.docs.has(p)) review.collections.back.push(name(plan.state));
            else if (!plan.docs.has(p)) review.collections.gone.push(name(this.state));
            else review.collections.changed.push(name(plan.state));
          }
          else if (!this.docs.has(p)) review.entries.back.push(entry(plan.state));
          else if (!plan.docs.has(p)) review.entries.gone.push(entry(this.state));
          else review.entries.changed.push(entry(plan.state));
        } else if (p === `${DOC_DIR}/site.json`) review.site = true;
        else if (p === `${DOC_DIR}/tokens.json`) review.styles = true;
        else if (p === ASSETS_DOC) review.library = true;
      }
      const ids = new Set([...Object.keys(plan.state.components), ...Object.keys(this.state.components)]);
      review.components = [...ids].filter((c) => JSON.stringify(plan.state.components[c] ?? null) !== JSON.stringify(this.state.components[c] ?? null)).length;
      review.files = plan.files.map((f) => f.path);
      review.replaced = plan.files.filter((f) => f.replaces).map((f) => f.path);
      review.left = plan.left;
      review.others = plan.others;
      review.unchanged = !differs && !plan.files.length;
      return { ok: true, review };
    }, false);
  }

  /**
   * Restore saved version `id`, as reviewed at `expectedRevision` with `reviewed` files to put back. Whatever each of
   * those files holds now is copied aside first, and the work the restore replaces is saved as a version of its own
   * (holding those files too), unless one already holds exactly that, so the way back outlasts the undo history. Then
   * the files are put back and the documents saved as one ordinary step that Undo takes back. Undo changes documents
   * only: a file put back over another stays (the version saved first has the other), and one put back where none was
   * is never removed, so every step history keeps still finds the files it names. If anything fails before the
   * documents' save is journaled, the files go back to what they held; a stop part way is reported on reopening.
   */
  restoreVersion(id: string, expectedRevision: number, reviewed?: { files: string[]; replaced: string[]; others?: string[] }): Promise<RestoreVersionResult> {
    return this.serialize(async () => {
      const why = (await this.versionsBlocked()) ?? (await this.pendingVersionBlocks());
      if (why) return { ok: false, message: why };
      const v = this.versions.versions.find((x) => x.id === id);
      if (!v) return { ok: false, message: 'That saved version is no longer there.' };
      const stale = { ok: false, stale: true, message: 'The project changed since this version was reviewed. Review it again before restoring.' };
      if (expectedRevision !== this.revision) return stale;
      const plan = await this.restorePlan(v);
      if (!plan.ok) return { ok: false, message: plan.message };
      // A file changed outside the app since the review would be put back without the author having been told.
      const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      if (reviewed && (!same(reviewed.files, plan.files.map((f) => f.path)) || !same(reviewed.replaced, plan.files.filter((f) => f.replaces).map((f) => f.path)))) return stale;
      // So would one of the other files a restore doesn't copy, come to differ or stopped differing since (#1396): a
      // route written by hand where the version's page goes, say.
      if (reviewed?.others && !same(reviewed.others, plan.others)) return stale;
      const docsChange = plan.docs.size !== this.docs.size || [...plan.docs].some(([p, c]) => this.docs.get(p) !== c);
      // What it doesn't copy from the version, as of now (#1396).
      const others = plan.others.length ? { others: plan.others } : {};
      if (!docsChange && !plan.files.length) return { ok: true, unchanged: true, revision: this.revision, ...others };
      // A change made outside the app and not loaded yet would vanish under the restore: it waits for it.
      const unloaded = await this.unloadedEdit(new Set());
      if (unloaded) return { ok: false, message: `${unloaded} changed outside the app. Try again in a moment.` };
      // What each file holds now, by hash, one at a time; whatever would be replaced is copied aside, path and all.
      const aside = `restore-${Date.now()}`;
      const prior = new Map<string, string | null>();
      for (const f of plan.files) {
        const abs = safeJoin(this.dir, f.path);
        let bytes: Buffer | null = null;
        try {
          if (!(await fs.lstat(abs)).isFile()) return { ok: false, message: `${f.path} is not a file, so nothing was restored.` };
          bytes = await fs.readFile(abs);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, message: `${f.path} could not be read, so nothing was restored: ${(e as Error).message}` };
        }
        if (!!bytes !== f.replaces) return stale;
        prior.set(f.path, bytes && sha(bytes));
        if (bytes && sha(bytes) !== f.hash) await atomicWrite(this.local('recovery', aside, f.path), bytes);
      }
      // The way back. If it can't be saved nothing is restored; a stop after it leaves one more version.
      const replaced = plan.files.filter((f) => prior.get(f.path)).map((f) => f.path);
      const filled = Object.fromEntries(plan.files.filter((f) => !prior.get(f.path)).map((f) => [f.path, f.hash]));
      let backup: SavedVersion;
      // With Git snapshots on, what the restore leaves is saved after it as a version of its own (#1155): decided once,
      // by the store the way back went to.
      let inGit = false;
      let damaged = false;
      try {
        // With the version history damaged, the way back is saved in the plain store instead: a restore still has one.
        const now = await this.captureVersion(backupName(v.name), { auto: true, also: replaced, filled }).catch((e: unknown) => {
          if (!(e instanceof HistoryDamaged)) return Promise.reject(e);
          damaged = true;
          return this.captureVersion(backupName(v.name), { auto: true, also: replaced, filled, plain: true });
        });
        inGit = !!now.git;
        // A version that already holds exactly this is the way back: in the store the work was just saved to (whose objects
        // that save has checked or written again), and with Git snapshots on, of the whole site, its tree the same.
        const kept = await this.versions.sameAs(now, undefined, true);
        if (kept) backup = kept;
        else {
          if (!(await this.stillOwner())) return { ok: false, message: this.readOnly?.reason ?? LOCK_UNCHECKED };
          backup = await this.versions.add(now);
        }
      } catch (e) {
        return { ok: false, message: `Your current work could not be saved first, so nothing was restored. ${(e as Error).message}` };
      }
      const way = { id: backup.id, name: backup.name };
      this.emit('history');
      const label = `Restore “${v.name}”`;
      const written: Array<{ path: string; hash: string; prior: string | null }> = [];
      let ev: SessionEvent | null = null;
      // The ID of the version recording what the restore leaves, noted with it so a stop is matched with that version.
      const op = inGit ? newVersionId() : undefined;
      const earlier = await this.versions.markRestoring(v.name, way.name, op);
      const clear = async () => {
        if (!earlier) await this.versions.clearRestoring().catch(() => undefined);
      };
      const docsBefore = this.docs;
      try {
        // The version's files and the documents saved with them reach the preview as one update.
        ev = await this.publishing(async () => {
          for (const f of plan.files) {
            const before = prior.get(f.path) ?? null;
            if (before === f.hash) continue;
            // A takeover by another app, or a change to the file since it was copied aside, stops the restore.
            if (!(await this.stillOwner())) throw new RestoreStopped(this.readOnly?.reason ?? LOCK_UNCHECKED);
            const abs = safeJoin(this.dir, f.path);
            // Read before the file is checked, so as little time as possible passes between the check and the write.
            const bytes = await this.versions.readFile(v, f.path, f.hash);
            const now = await fs.readFile(abs).then(sha, (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
            if (now !== before || (await linkOnTheWay(this.dir, f.path))) throw new RestoreStopped(`${f.path} changed while the version was being restored, so nothing was restored.`);
            // Noted before writing: a write that lands but fails to report so is still undone.
            written.push({ path: f.path, hash: f.hash, prior: before });
            await atomicWrite(abs, bytes);
            this.landing?.add(f.path);
          }
          if (written.length) await this.refreshAssetFiles().catch(() => false);
          if (!(await this.stillOwner())) throw new RestoreStopped(this.readOnly?.reason ?? LOCK_UNCHECKED);
          // Read from the version's files, every document is a new object: those that read the same are the project's
          // own (shareUnchanged), so the editor is sent only the documents the restore changes (#967).
          return docsChange ? await this.persist(shareUnchanged(this.state, this.docs, plan.state, plan.docs), { label, source: 'user', restore: true }) : null;
        });
      } catch (e) {
        // Once the documents are saved (in place, or journaled for reopening to finish), the files stay with them; before
        // that, nothing of the restore is kept.
        const installed = this.docs !== docsBefore;
        const journaled = this.unsettled && existsSync(this.local('journal.json'));
        if (installed && !journaled) await clear();
        if (!installed && !journaled) {
          if (await this.putFilesBack(written, aside)) await clear();
          if (written.length) await this.refreshAssetFiles().catch(() => false);
        }
        if (e instanceof DiskConflictError || e instanceof RestoreStopped) return { ok: false, message: e.message, backup: way };
        throw e;
      }
      if (!ev) this.emit('changed', { revision: this.revision, changedDocs: [], changedFiles: written.map((w) => w.path), label, source: 'user' } satisfies SessionEvent);
      let notice: string | undefined;
      if (op) {
        // Everything is back: a stop from here is told as the version of it not saved, not as a restore that may have
        // left something out. The note stays until the version is noted itself, so a stop is never told of by neither.
        if (!earlier) await this.versions.settleRestoring(v.name, way.name, op).catch(() => undefined);
        notice = await this.recordRestore(v, way, op, plan.files.map((f) => f.path));
      } else if (damaged) notice = 'The project’s version history is damaged, so the site as restored was not added to it.';
      await clear();
      return { ok: true, revision: this.revision, entryId: ev?.entryId, backup: way, replaced: written.filter((w) => w.prior).length, left: plan.left, ...others, ...(notice ? { notice } : {}) };
    });
  }

  /**
   * Undo a restore's file writes, each only while it still holds what the restore wrote: a file goes back to the copy
   * set aside in recovery/`aside`, and one that was not there is removed again. Says whether every one was settled.
   */
  private async putFilesBack(written: Array<{ path: string; hash: string; prior: string | null }>, aside: string): Promise<boolean> {
    let clean = true;
    for (const w of [...written].reverse()) {
      try {
        const abs = safeJoin(this.dir, w.path);
        // The copy is read first, so the check below comes as close to the write as it can.
        const copy = w.prior === null ? null : await fs.readFile(this.local('recovery', aside, w.path));
        if (copy && sha(copy) !== w.prior) throw new Error('The copy set aside is damaged.');
        const now = await fs.readFile(abs).then(sha, (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
        // Never written, or changed again since by someone else: either way, not the restore's to touch.
        if (now !== w.hash) continue;
        if (copy) await atomicWrite(abs, copy);
        else await removeDurable(abs);
      } catch {
        clean = false;
      }
    }
    return clean;
  }

  /**
   * With Git snapshots on, save the site as restoring `v` left it as a version of its own, on top of the history
   * (#1155): a restore goes forward, never back. The whole site is committed on the versions branch's tip, the version
   * noted with the commit the branch moves from (VersionStore.recordPending), and only then the branch moved and the
   * row listed, so a stop anywhere is finished on reopening rather than repeated. The restore itself is done whatever
   * happens here: gives what to tell the author when the version is not, or not yet, saved.
   */
  private async recordRestore(v: SavedVersion, backup: { name: string }, op: string, files: string[]): Promise<string | undefined> {
    const notSaved = (why: string) => `The site as restored could not be saved as a version of its own. ${why}`;
    const git = versionsGit();
    if (!git) return notSaved('The project’s version history can’t be reached.');
    try {
      // A change made outside the app meanwhile is not the restore's to record: it is loaded as ever, and the version
      // of the restore not saved, rather than either taken for the other.
      const before = await this.unloadedEdit(new Set());
      if (before) return notSaved(`${before} changed outside the app meanwhile.`);
      const row = await this.captureGitVersion(git, restoredName(v.name), { restored: { id: op }, also: files });
      const late = await this.unloadedEdit(new Set());
      if (late) return notSaved(`${late} changed outside the app meanwhile.`);
      if (!(await this.stillOwner())) return notSaved(this.readOnly?.reason ?? LOCK_UNCHECKED);
      const expected = (await git.repository(this.dir).readCommit(row.git!.commit)).parents[0] ?? null;
      const record = { op, version: v.name, backup: backup.name, expected, row };
      await this.versions.writePending(record).catch(async (e: unknown) => {
        // Written whole though its folder could not be flushed: it stands, and is finished like any other.
        const there = await this.versions.readPending().catch(() => null);
        if (!there || typeof there === 'string' || JSON.stringify(there) !== JSON.stringify(record)) throw e;
        await this.versions.flushPending().catch(() => Promise.reject(e));
      });
    } catch (e) {
      // Not noted, or perhaps noted only part way (its folder could not be flushed): nothing is left to finish.
      await this.versions.clearPending().catch(() => undefined);
      return notSaved(e instanceof GitError ? gitSaveProblem(e) : (e as Error).message);
    }
    const r = await this.versions.recordPending().catch((e: Error): PendingOutcome => ({ state: 'pending', op, version: v.name, backup: backup.name, reason: e.message }));
    this.emit('history');
    if (r.state === 'pending') return `The site as restored is not in Saved versions yet. ${r.reason} It is added the next time the project opens or a version is saved.`;
    if (r.state === 'moved') return 'The project’s version history was changed by something else meanwhile, so the site as restored was not added to it.';
    return undefined;
  }

  /**
   * Finish recording the version a restore left (#1155) before anything else moves the versions branch. Says why no
   * version can be saved to Git now, while that is still to be done.
   */
  private async pendingVersionBlocks(): Promise<string | null> {
    const r = await this.versions.recordPending().catch(() => null);
    if (r?.state === 'recorded' && r.op) this.emit('history');
    if (r?.state !== 'pending' && !(r?.state === 'unreadable' && r.retry)) return null;
    const git = versionsGit();
    if (!git || !(await git.enabled())) return null;
    if (r.state === 'unreadable') return 'The version still being saved after a restore could not be read just now. Try again in a moment.';
    return `The site as restoring “${r.version}” left it is not in Saved versions yet. ${r.reason} Try again in a moment.`;
  }

  /** Give saved version `id` another name. What it holds, and when it was saved, stay as they are. */
  renameVersion(id: string, name: string): Promise<{ ok: boolean; message?: string }> {
    return this.serialize(async () => {
      const blocked = await this.writeBlocked();
      if (blocked) return { ok: false, message: blocked.error?.message };
      if (this.versions.problem) return { ok: false, message: this.versions.problem };
      const clean = name.replace(/\s+/g, ' ').trim();
      if (!clean) return { ok: false, message: 'Give the version a name.' };
      if (clean.length > VERSION_NAME_MAX) return { ok: false, message: `Use a name of at most ${VERSION_NAME_MAX} characters.` };
      const v = this.versions.versions.find((x) => x.id === id);
      if (!v) return { ok: false, message: 'That saved version is no longer there.' };
      if (v.name === clean) return { ok: true };
      try {
        await this.versions.publish(this.versions.versions.map((x) => (x.id === id ? { ...x, name: clean } : x)));
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
      this.emit('history');
      return { ok: true };
    });
  }

  /** Delete saved version `id`, and what no other version holds. */
  deleteVersion(id: string): Promise<{ ok: boolean; message?: string; freed?: number }> {
    return this.serialize(async () => {
      const blocked = await this.writeBlocked();
      if (blocked) return { ok: false, message: blocked.error?.message };
      if (this.versions.problem) return { ok: false, message: this.versions.problem };
      const left = this.versions.versions.filter((v) => v.id !== id);
      if (left.length === this.versions.versions.length) return { ok: true, freed: 0 };
      try {
        await this.versions.forgetPending(id);
        await this.versions.publish(left);
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
      const freed = await this.versions.collect().catch(() => 0);
      this.emit('history');
      return { ok: true, freed };
    });
  }

  /** A canonical document, other than `skip`, that differs on disk from the loaded project, or a page file it lacks. */
  private async unloadedEdit(skip: Set<string>): Promise<string | null> {
    for (const [path, cur] of this.docs) if (!skip.has(path) && !sameContent(path, await this.diskContent(path), cur)) return path;
    // A brief written outside the app while the project had none.
    if (!this.docs.has(BRIEF_FILE) && !skip.has(BRIEF_FILE) && existsSync(join(this.dir, BRIEF_FILE))) return BRIEF_FILE;
    if (!this.docs.has(PUBLISHED_FILE) && !skip.has(PUBLISHED_FILE) && existsSync(join(this.dir, PUBLISHED_FILE))) return PUBLISHED_FILE;
    for (const f of await fs.readdir(join(this.dir, DOC_DIR, 'pages')).catch(() => [] as string[])) {
      const path = `${DOC_DIR}/pages/${f}`;
      if (isCanonicalPath(path) && !this.docs.has(path) && !skip.has(path)) return path;
    }
    // A component added outside the app (a folder left by an interrupted delete has no definition, and is no edit).
    for (const d of await fs.readdir(join(this.dir, DOC_DIR, 'components')).catch(() => [] as string[])) {
      const path = `${DOC_DIR}/components/${d}/component.json`;
      if (isCanonicalPath(path) && !this.docs.has(path) && !skip.has(path) && existsSync(join(this.dir, path))) return path;
    }
    // A collection or an entry added outside the app.
    for (const c of await fs.readdir(join(this.dir, DOC_DIR, 'collections')).catch(() => [] as string[])) {
      const paths = [`${DOC_DIR}/collections/${c}/collection.json`];
      for (const f of await fs.readdir(join(this.dir, DOC_DIR, 'collections', c, 'entries')).catch(() => [] as string[])) paths.push(`${DOC_DIR}/collections/${c}/entries/${f}`);
      for (const path of paths) if (isCanonicalPath(path) && !this.docs.has(path) && !skip.has(path) && existsSync(join(this.dir, path))) return path;
    }
    // A source added outside the app.
    for (const d of await fs.readdir(join(this.dir, DOC_DIR, 'sources')).catch(() => [] as string[])) {
      // Its converter only while its settings name one: a module beside settings that do not is no part of the project.
      const declared = Object.hasOwn(this.state.sources ?? {}, d) && this.state.sources![d].converter !== undefined;
      for (const path of [`${DOC_DIR}/sources/${d}/source.json`, ...(declared ? [`${DOC_DIR}/sources/${d}/converter.mjs`] : [])])
        if (isCanonicalPath(path) && !this.docs.has(path) && !skip.has(path) && existsSync(join(this.dir, path))) return path;
    }
    return null;
  }

  /**
   * Move history to `to`, an undo position: restore the documents of every entry between it and the current one, as
   * one change however many entries that is. Each entry's documents must still be as it left them (once the entries
   * nearer the present are taken back, or the ones before it redone), or nothing changes. Only where it arrives is
   * checked as a whole project, since nothing in between is ever saved.
   */
  private async travel(to: number): Promise<ApplyResult> {
    const h = this.history;
    const direction = to < h.cursor ? 'undo' : 'redo';
    // In the order they are taken back or put back.
    const steps = direction === 'undo' ? h.entries.slice(to, h.cursor).reverse() : h.entries.slice(h.cursor, to);
    const expect = direction === 'undo' ? 'after' : 'before';
    const target = direction === 'undo' ? 'before' : 'after';
    const what = steps.length === 1 ? `"${steps[0].label}"` : `${steps.length} changes`;
    // Build the target state from documents, an entry at a time.
    const docs = new Map(this.docs);
    for (const entry of steps) {
      for (const [path, d] of Object.entries(entry.docs)) {
        const cur = docs.get(path);
        const curHash = cur === undefined ? null : sha(cur);
        if (curHash !== d[expect])
          return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} "${entry.label}" because ${path} has changed since.`, recoverable: false } };
      }
      for (const [path, d] of Object.entries(entry.docs)) {
        const blob = d[target];
        if (blob === null) docs.delete(path);
        else docs.set(path, await this.getBlob(blob));
      }
    }
    // An entry is kept only with its collection: a restore that would leave one without it (its collection deleted
    // outside the app since) cannot be saved.
    // Nor beside another entry with its ID (one added to another collection outside the app since).
    const restored = collectionsFromDocs([...docs].filter(([p]) => collectionPathOf(p)).map(([p, c]) => [p, JSON.parse(c)]));
    const unsaveable = restored.orphans.length ? `${restored.orphans[0]} would have no collection` : restored.duplicates.length ? `${restored.duplicates[0]} would share its entry ID with another entry` : null;
    if (unsaveable) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} ${what}: ${unsaveable}.`, recoverable: false } };
    // The documents it does not change are the very objects the project holds (shareUnchanged).
    const next = shareUnchanged(this.state, this.docs, docsToState(docs, this.state), docs);
    // History restores only its own documents, and another may have changed outside the app since (a page now on
    // a route this restores, an old address kept there): never save a project that could not be opened again.
    const fatal = (s: ProjectState) => this.coreOf(s).core.filter((d) => d.severity === 'error' && FATAL_CODES.has(d.code));
    const already = new Set(fatal(this.state).map((d) => d.message));
    const broken = fatal(next).find((d) => !already.has(d.message));
    if (broken) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} ${what}: ${broken.message}`, recoverable: false } };
    // Nor one that rewrites a synced collection's entries (an edit made before it was synced, say), as no change may,
    // except a collection only restores of saved versions on the way change (#1474): a restore may rewrite its entries,
    // so taking one back, or putting it back again, may too. Nor one that takes away what such an entry needs, or
    // leaves a collection synced from a source that is gone.
    // A collection left out must still hold only entries its source wrote: one synced since from another, say.
    const byRestore = restoredOnly(steps);
    const synced = syncedEntryChange(this.state, next, byRestore) ?? foreignSyncedEntry(next, byRestore) ?? syncedDependencyLoss(this.state, next) ?? sourceIntegrityChange(this.state, next);
    if (synced) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} ${what}: it ${synced}`, recoverable: false } };
    const pin = themePinProblem(next);
    if (pin) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} ${what}: ${pin}`, recoverable: false } };
    // That check sees the project as loaded. An edit made outside the app that has not been loaded yet would slip
    // past it, so the restore waits for it. Saving checks the documents it writes itself, as it writes them: only
    // those are left out here, not every one an entry on the way touched (one changed and changed back is not saved).
    const writes = new Set([...this.docs.keys(), ...docs.keys()].filter((p) => this.docs.get(p) !== docs.get(p)));
    const unloaded = await this.unloadedEdit(writes);
    if (unloaded) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} ${what} yet: ${unloaded} changed outside the app. Try again in a moment.`, recoverable: true } };
    let changed: string[];
    try {
      // The cursor moves in the same journaled change as the documents, so a crash never separates them.
      changed = (await this.persist(next, { label: `${direction === 'undo' ? 'Undo' : 'Redo'} ${steps.length === 1 ? steps[0].label : what}`, history: false, cursor: to, source: 'user' })).changedDocs;
    } catch (e) {
      if (e instanceof DiskConflictError) return { ok: false, revision: this.revision, error: this.diskConflict(e) };
      throw e;
    }
    this.emit('history');
    // What it changed and the step it took, so the editor can say so when that is not on the page it shows (#903).
    return { ok: true, revision: this.revision, changed, ...(steps.length === 1 ? { label: steps[0].label } : {}) };
  }

  undo(): Promise<ApplyResult> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'Stop the AI before undoing.', recoverable: true } };
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      const entry = this.history.entries[this.history.cursor - 1];
      if (!entry) return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to undo.', recoverable: true } };
      return this.travel(this.history.cursor - 1);
    });
  }

  redo(): Promise<ApplyResult> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'Stop the AI before redoing.', recoverable: true } };
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      const entry = this.history.entries[this.history.cursor];
      if (!entry) return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to redo.', recoverable: true } };
      return this.travel(this.history.cursor + 1);
    });
  }

  /**
   * Step History to an entry chosen in it, however far back or ahead, in one change: `undo` undoes that entry and
   * every applied one after it, `redo` redoes every undone entry up to and including it. What is undone can still be
   * redone until a new change is made. An entry that has gone, or already stands where it was asked to go (History
   * moved after it was shown), is refused, changing nothing, so this never goes somewhere other than where it names;
   * so is any step once History is not as it was shown (`expected`): the project has moved on from its revision, or the
   * step would no longer take `count` changes (an AI turn recorded since, at the revision of its last change).
   */
  stepTo(entryId: string, direction: 'undo' | 'redo', expected: { revision?: number; count?: number } = {}): Promise<ApplyResult> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, revision: this.revision, error: { code: 'BUSY', message: `Stop the AI before ${direction === 'undo' ? 'undoing' : 'redoing'}.`, recoverable: true } };
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      // Chosen from History as it stood at `expectedRevision`: a change made since (one folded into the same entry,
      // say) would make the step take back more, or other, than the row said.
      const stale = { ok: false, revision: this.revision, error: { code: 'STALE_REVISION', message: 'History changed. Choose the change again.', recoverable: true } } satisfies ApplyResult;
      if (expected.revision !== undefined && expected.revision !== this.revision) return stale;
      const h = this.history;
      const at = h.entries.findIndex((e) => e.id === entryId);
      const entry = h.entries[at];
      if (!entry) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: 'That change is no longer in History.', recoverable: false } };
      if (direction === 'undo' && at >= h.cursor) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `“${entry.label}” was already undone.`, recoverable: false } };
      if (direction === 'redo' && at < h.cursor) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `“${entry.label}” was already redone.`, recoverable: false } };
      const to = direction === 'undo' ? at : at + 1;
      if (expected.count !== undefined && expected.count !== Math.abs(h.cursor - to)) return stale;
      return this.travel(to);
    });
  }

  /** Undo a specific history group only when it is the latest applied group. */
  undoGroup(runId: string): Promise<ApplyResult> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'Stop the AI before undoing.', recoverable: true } };
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      const latest = this.history.entries[this.history.cursor - 1];
      if (!latest || latest.runId !== runId)
        return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: 'Later changes were made after this AI turn. Undo those first from the history.', recoverable: false } };
      return this.travel(this.history.cursor - 1);
    });
  }

  /**
   * Undo or redo `steps` History entries for the AI run `runId`, which the author asked to do just that (#1405): the
   * same step the toolbar's Undo or Redo takes, recorded as the author's, never as an AI change. The run lets go of
   * the project for it, so it must have changed nothing, and the project must be at the revision the run started from:
   * an edit of the author's saved while it waited moves what "the latest change" is, and the step is refused. Once taken,
   * the run holds nothing (completeRun and abortRun find no run) and can change nothing more.
   */
  stepHistoryForRun(runId: string, direction: 'undo' | 'redo', steps = 1): Promise<ApplyResult> {
    return this.serialize(async () => {
      const run = this.activeRun;
      const refuse = (code: ToolErrorCode, message: string, recoverable = false): ApplyResult => ({ ok: false, revision: this.revision, error: { code, message, recoverable } });
      if (!run || run.id !== runId) return refuse('CONFLICT', 'This request no longer holds the project.');
      if (this.runChanged()) return refuse('CONFLICT', `This request has already changed the site, so it cannot also ${direction}. The author can ${direction} from the toolbar once it finishes.`);
      if (this.revision !== run.startRevision) return refuse('STALE_REVISION', `The author saved changes while this request ran, so its ${direction} might take back other changes than they meant. Nothing was ${direction === 'undo' ? 'undone' : 'redone'}: ask them to send it again.`);
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      const h = this.history;
      const to = direction === 'undo' ? h.cursor - steps : h.cursor + steps;
      const left = direction === 'undo' ? h.cursor : h.entries.length - h.cursor;
      if (!left) return refuse('INVALID_ARGUMENT', `Nothing to ${direction}.`);
      if (to < 0 || to > h.entries.length) return refuse('INVALID_ARGUMENT', `Only ${left} ${left === 1 ? 'change' : 'changes'} can be ${direction === 'undo' ? 'undone' : 'redone'}.`, true);
      // Unchanged since its checkpoint, the run's project is the author's as it was: letting go of it restores nothing.
      const at = { revision: this.revision, cursor: h.cursor };
      const label = steps === 1 ? h.entries[direction === 'undo' ? h.cursor - 1 : h.cursor].label : undefined;
      this.activeRun = null;
      /** Nothing of the step was written: the run may hold the project again, as it was. Once anything was, the step
       *  is the author's and stays (restoring the run would let its rollback write the old documents under a moved cursor). */
      const untouched = () => this.revision === at.revision && this.history.cursor === at.cursor && !this.unsettled;
      // A marker left behind names no document the run changed, so reopening restores nothing from it.
      const letGo = () => removeDurable(this.local('sessions', 'active-run.json')).catch(() => undefined);
      let r: ApplyResult;
      try {
        r = await this.travel(to);
      } catch (e) {
        if (untouched()) {
          this.activeRun = run;
          throw e;
        }
        // Saved, and something after the save failed (a listener): the step landed, and is reported as it stands. A
        // save that did not finish is reopening's to settle, and is no success.
        await letGo();
        if (this.history.cursor !== to || this.unsettled) throw e;
        return { ok: true, revision: this.revision, ...(label ? { label } : {}) };
      }
      if (!r.ok) {
        if (untouched()) this.activeRun = run;
        else await letGo();
        return r;
      }
      await letGo();
      return r;
    });
  }

  /**
   * Undo one history entry, for an Undo offered beside the change it made. The newest entry is undone like Undo.
   * An older one is undone on its own only when it removed one section or element from a page and nothing since
   * stands in the way: that subtree is put back where it was, as a new change, and every later edit stays. Anything
   * else is refused, changing nothing, so this never undoes a different change from the one it names.
   */
  undoEntry(entryId: string): Promise<ApplyResult> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'Stop the AI before undoing.', recoverable: true } };
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      const h = this.history;
      const at = h.entries.findIndex((e) => e.id === entryId);
      const entry = h.entries[at];
      if (!entry) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: 'That change is no longer in History.', recoverable: false } };
      if (at >= h.cursor) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `“${entry.label}” was already undone.`, recoverable: false } };
      if (at === h.cursor - 1) return this.travel(at);
      return this.restoreOnItsOwn(entry, at);
    });
  }

  /** Put back what an older, still applied history entry removed from a page, keeping every later change (see undoEntry). */
  private async restoreOnItsOwn(entry: HistoryEntry, at: number): Promise<ApplyResult> {
    const refuse = (why?: string): ApplyResult => ({
      ok: false,
      revision: this.revision,
      error: { code: 'CONFLICT', message: `Other changes came after “${entry.label}”${why ? `, so it can’t be undone on its own. ${why}` : '.'} Open History to undo it.`, recoverable: false }
    });
    const paths = Object.keys(entry.docs);
    const path = paths[0];
    const pageId = path?.match(PAGE_DOC)?.[1];
    const d = entry.docs[path];
    if (paths.length !== 1 || !pageId || !d.before || !d.after) return refuse();
    const page = this.state.pages[pageId];
    if (!page) return refuse('Its page has been deleted.');
    const versions = new Map<string, PageDoc | null>();
    const read = async (hash: string) => {
      if (!versions.has(hash)) versions.set(hash, await this.getBlob(hash).then((t) => JSON.parse(t) as PageDoc, () => null));
      return versions.get(hash)!;
    };
    const lost = 'History no longer holds the page as it was.';
    const [before, after] = [await read(d.before), await read(d.after)];
    if (!before || !after) return refuse(lost);
    const removal = findRemoval(before, after);
    if (!removal) return refuse();
    // What the page went through since. Once the subtree has been back (put back by an earlier Undo, say, and then
    // deleted again), this removal is no longer the one that took it away.
    for (const e of this.history.entries.slice(at + 1, this.history.cursor)) {
      const later = e.docs[path];
      if (!later) continue;
      if (!later.before || !later.after) return refuse('Its page has been deleted and made again since.');
      for (const v of [await read(later.before), await read(later.after)]) {
        if (!v) return refuse(lost);
        if (Object.hasOwn(v.nodes, removal.rootId)) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `“${entry.label}” was already undone.`, recoverable: false } };
      }
    }
    let put = restoreRemoval(before, removal, page);
    if (!put.ok && put.gap) {
      // Only versions the page really went through count: an undone change shows an order the user took back.
      // A version history can no longer read could have shown another order, so it refuses rather than skips.
      const applied: PageDoc[] = [];
      for (const e of this.history.entries.slice(0, this.history.cursor).reverse())
        for (const hash of [e.docs[path]?.after, e.docs[path]?.before]) {
          if (!hash) continue;
          const v = await read(hash);
          if (!v) return refuse(lost);
          applied.push(v);
        }
      put = restoreRemoval(before, removal, page, applied);
    }
    if (!put.ok) return refuse(put.reason);
    const taken = anchorsInUse(this.state, { kind: 'page', id: pageId });
    const clash = removal.ids.map((id) => before.nodes[id].anchor).find((a) => a && taken.has(a));
    if (clash) return refuse(`Something else on the page now uses its anchor “#${clash}”.`);
    const next: ProjectState = { ...this.state, pages: { ...this.state.pages, [pageId]: { ...page, rootIds: put.tree.rootIds, nodes: put.tree.nodes } } };
    // What it brings back must still make sense with everything changed since (a component or image it uses may be
    // gone). Diagnostics are told apart by where they are, as two missing images on one page share a message.
    const known = new Set(this.savingProblems(this.state).map(diagnosticKey));
    const introduced = this.savingProblems(next).filter((x) => !known.has(diagnosticKey(x)));
    if (introduced.length) return refuse(introduced.map((x) => x.message).join(' '));
    let ev: SessionEvent;
    try {
      ev = await this.persist(next, { label: `Restore ${displayName(next, put.tree.nodes[put.rootId])}`, source: 'user' });
    } catch (e) {
      if (e instanceof DiskConflictError) return { ok: false, revision: this.revision, error: this.diskConflict(e) };
      throw e;
    }
    return { ok: true, revision: this.revision, changed: ev.changedDocs, entryId: ev.entryId };
  }

  /**
   * What an AI turn's History step changed, the changes applied after it and how each stands with it, and whether the
   * turn can be taken back on its own (issue 164). It never writes.
   */
  reviewAiEntry(entryId: string): Promise<{ ok: boolean; message?: string; review?: AiTurnReview }> {
    // Queued behind any save, so it reads a settled project and History.
    return this.serialize(async () => {
      const r = await this.aiTurnReview(entryId);
      return 'error' in r ? { ok: false, message: r.error } : { ok: true, review: r.review };
    }, false);
  }

  /**
   * Take an AI turn back on its own, as reviewed at `expected.revision` (see reviewAiEntry): each document its step
   * wrote goes back to how the step found it, as one new change that can itself be undone, and every change made
   * after it stays. Refused, changing nothing, when a later change depends on the turn, the result would break
   * something, or the project has changed since the review.
   */
  revertAiEntry(entryId: string, expected: { revision?: number; history?: string } = {}): Promise<ApplyResult> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'Stop the AI before undoing.', recoverable: true } };
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      // Reviewed at this revision and History as it was then: an AI step recorded since, or one let go, changes what
      // the review said would be kept or no longer redoable, even at the same revision.
      if ((expected.revision !== undefined && expected.revision !== this.revision) || (expected.history !== undefined && expected.history !== historyKey(this.history)))
        return { ok: false, revision: this.revision, error: { code: 'STALE_REVISION', message: 'The project changed. Review the turn again.', recoverable: true } };
      const r = await this.aiTurnReview(entryId);
      if ('error' in r) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: r.error, recoverable: false } };
      const { review, next, entry } = r;
      if (!review.revert.ok || !next) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: review.revert.ok ? 'This turn can’t be undone on its own.' : review.revert.reason, recoverable: false } };
      // As in travel: an edit made outside the app that has not been loaded yet would slip past the checks.
      const unloaded = await this.unloadedEdit(new Set(Object.keys(entry.docs)));
      if (unloaded) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot undo “${entry.label}” yet: ${unloaded} changed outside the app. Try again in a moment.`, recoverable: true } };
      let ev: SessionEvent;
      try {
        ev = await this.persist(next, { label: `Undo AI turn: ${entry.label.replace(/^AI(?: \(partial\))?: /, '')}`, source: 'user', revertsRunId: entry.runId });
      } catch (e) {
        if (e instanceof DiskConflictError) return { ok: false, revision: this.revision, error: this.diskConflict(e) };
        throw e;
      }
      return { ok: true, revision: this.revision, changed: ev.changedDocs, entryId: ev.entryId };
    });
  }

  /**
   * A step's documents, each version parsed (authored code stays text, and a document that is not JSON is its text);
   * null when History no longer holds one. Absent is only ever a version the step recorded as none.
   */
  private async stepVersions(entry: HistoryEntry): Promise<DocVersions[] | null> {
    const read = async (path: string, hash: string | null) => {
      if (hash === null) return null;
      const text = await this.getBlob(hash);
      if (!path.endsWith('.json')) return text;
      try {
        return (JSON.parse(text) as unknown) ?? text;
      } catch {
        return text;
      }
    };
    try {
      const out: DocVersions[] = [];
      for (const [path, d] of Object.entries(entry.docs)) out.push({ path, before: await read(path, d.before), after: await read(path, d.after) });
      return out;
    } catch {
      return null;
    }
  }

  /** A document by what it holds, as the review names it. */
  private docName(path: string): string {
    const page = path.match(PAGE_DOC)?.[1];
    if (page) return this.state.pages[page]?.title ?? 'a page';
    if (path === `${DOC_DIR}/site.json`) return 'the site settings, header or footer';
    if (path === `${DOC_DIR}/tokens.json` || path === `${DOC_DIR}/theme-lock.json`) return 'the site styles';
    if (path === `${DOC_DIR}/assets.json`) return 'the library';
    const source = sourcePathOf(path) ?? converterPathOf(path);
    if (source !== null) return this.state.sources?.[source]?.name ?? 'an external source';
    const component = Object.values(this.state.components).find((d) => componentDocPath(d.id) === path || d.sourcePath === path);
    return component ? component.name : path;
  }

  /**
   * The review of AI step `entryId`, and the project with it taken back on its own when that can be done: each of the
   * step's documents as the step found it, every other document as it is now. A later applied step depends on the
   * turn when it changed one of the turn's documents (taking the turn back would take that change with it, or leave it
   * on something the turn made), added a link to a page the turn made (by the page, or typed as the site's own web
   * address), or changed a placement of a component whose design the turn changed. With none depending, the result is
   * still refused when it would break something: a check the project fails that it passes now, a link left to a page
   * that would be gone or no longer published, or code that needs a component the turn added.
   */
  private async aiTurnReview(entryId: string): Promise<{ error: string } | { review: AiTurnReview; next?: ProjectState; entry: HistoryEntry & { runId: string } }> {
    const h = this.history;
    const at = h.entries.findIndex((e) => e.id === entryId);
    const found = h.entries[at];
    if (!found) return { error: 'That change is no longer in History.' };
    if (found.source !== 'ai' || !found.runId) return { error: 'That change was not made by the AI.' };
    const entry = found as HistoryEntry & { runId: string };
    const versions = await this.stepVersions(entry);
    const applied = at < h.cursor;
    const reverter = h.entries.slice(0, h.cursor).find((e) => e.revertsRunId === entry.runId);
    // What the turn made or published that taking it back takes away (by page, and by the address it answers at), and
    // the designs it changed that later work may build on.
    const made = new Map<string, { title: string; how: 'added' | 'published' }>();
    const addresses = new Set<string>();
    const moved = new Map<string, string>();
    const designs = new Set<string>();
    let siteBefore: unknown = null;
    for (const v of versions ?? []) {
      const page = v.path.match(PAGE_DOC)?.[1];
      const [b, a] = [v.before as Partial<PageDoc> | null, v.after as Partial<PageDoc> | null];
      const title = a && typeof a === 'object' && typeof a.title === 'string' ? a.title : 'a page';
      const published = !!b && typeof b === 'object' && b.draft === true && !!a && typeof a === 'object' && a.draft !== true;
      if (page && a && typeof a === 'object' && (!b || published)) made.set(page, { title, how: b ? 'published' : 'added' });
      if (page && a && typeof a === 'object' && typeof a.route === 'string') {
        if (!b || published) addresses.add(asRoute(a.route).toLowerCase());
        else if (b.route !== a.route) moved.set(asRoute(a.route).toLowerCase(), page);
      }
      // A design is what placements show: its name and description are only what the library calls it.
      const design = v.path.match(COMPONENT_DOC)?.[1] ?? Object.values(this.state.components).find((d) => d.sourcePath === v.path)?.id;
      const shown = (d: unknown) => (d && typeof d === 'object' ? { ...d, name: undefined, description: undefined, tags: undefined, category: undefined } : d);
      if (design && v.before !== null && v.after !== null && JSON.stringify(shown(v.before)) !== JSON.stringify(shown(v.after))) designs.add(design);
      if (v.path === `${DOC_DIR}/site.json`) siteBefore = v.before;
    }
    // An address a page moved to is lost by taking the move back unless an old address kept for that same page answered
    // there before the turn: one kept for another page would send a later link there instead.
    const redirects = (siteBefore && typeof siteBefore === 'object' ? (siteBefore as SiteDoc) : this.state.site).redirects ?? [];
    for (const [a, page] of moved) if (!redirects.some((r) => typeof r?.from === 'string' && asRoute(r.from).toLowerCase() === a && r.pageId === page)) addresses.add(a);
    // A link typed as the site's own address names it by the public URL the site has now, or had before the turn.
    const bases = siteBases(this.state.site, siteBefore && typeof siteBefore === 'object' ? (siteBefore as SiteDoc) : null);
    const pageIds = new Set(made.keys());
    /** A document as it is now, read the way stepVersions reads a step's. */
    const now = (path: string): unknown => {
      const text = this.docs.get(path);
      if (text === undefined || !path.endsWith('.json')) return text ?? null;
      try {
        return (JSON.parse(text) as unknown) ?? text;
      } catch {
        return text;
      }
    };
    // Each document as it was when the turn ended, before any later step changed it: a link it already held then is no
    // later change's doing, whatever later steps added and took away around it.
    const atTurn = new Map<string, unknown>();
    const later: TurnLaterChange[] = [];
    for (const e of h.entries.slice(at + 1, h.cursor)) {
      const own = await this.stepVersions(e);
      for (const v of own ?? []) if (!atTurn.has(v.path)) atTurn.set(v.path, v.before);
      const paths = Object.keys(e.docs).filter((p) => Object.hasOwn(entry.docs, p));
      const shared = paths.find((p) => entry.docs[p].before === null && entry.docs[p].after !== null) ?? paths[0];
      let reason: string | undefined;
      if (shared) reason = entry.docs[shared].before === null ? `It changes ${this.docName(shared)}, which this turn added.` : `It changes ${this.docName(shared)}, which this turn changed too.`;
      // Only what this change itself added, and what of it is still there, counts: a link it kept or that a later
      // change took out again, or a placement it left alone or deleted, is no reason.
      for (const v of own ?? []) {
        if (reason) break;
        const current = now(v.path);
        // By where each link goes: one swapped for a link elsewhere into what the turn made is a new link.
        const [after, before, nowLinks, then] = [v.after, v.before, current, atTurn.get(v.path) ?? null].map((d) => linksInto(d, pageIds, addresses, bases));
        if ([...after].some(([to, n]) => n > (before.get(to) ?? 0) && (nowLinks.get(to) ?? 0) > (then.get(to) ?? 0))) {
          const one = made.size === 1 ? [...made.values()][0] : null;
          reason = one ? `It adds a link to “${one.title}”, which this turn ${one.how}.` : 'It adds a link to a page this turn added or published.';
          continue;
        }
        const [was, became, stays] = [placementsOf(v.before, designs), placementsOf(v.after, designs), placementsOf(current, designs)];
        if ([...became].some(([id, text]) => stays.has(id) && was.get(id) !== text)) {
          const names = [...designs].map((id) => this.state.components[id]?.name).filter(Boolean);
          reason = `It changes where ${names.length === 1 ? `“${names[0]}”` : 'a component'} is used, after this turn changed its design.`;
        }
      }
      later.push({ entryId: e.id, label: e.label, source: e.source, time: e.time, changes: own ? stepChanges(own, this.state) : [], relation: reason ? 'depends' : 'separate', ...(reason ? { reason } : {}) });
    }
    const review: AiTurnReview = {
      entryId: entry.id,
      runId: entry.runId,
      label: entry.label,
      revision: this.revision,
      history: historyKey(h),
      applied,
      ...(reverter ? { revertedBy: { entryId: reverter.id, label: reverter.label } } : {}),
      changes: versions ? stepChanges(versions, this.state) : [],
      ...(versions ? {} : { detailsLost: true }),
      later,
      redoable: h.entries.length - h.cursor,
      revert: { ok: true }
    };
    const refuse = (reason: string) => {
      review.revert = { ok: false, reason };
      return { review, entry };
    };
    if (reverter) return refuse(`It was already undone on its own by “${reverter.label}”. Undo that change to bring the turn back.`);
    if (!applied) return refuse('It is already undone.');
    if (!versions) return refuse('History no longer holds what it changed.');
    const depends = later.filter((l) => l.relation === 'depends');
    if (depends.length) return refuse(`${depends.length === 1 ? 'A later change depends' : `${depends.length} later changes depend`} on it, so it can only be undone together with ${depends.length === 1 ? 'that change' : 'them'}.`);
    // Every one of its documents is still as it left them: no later step touched one, so only a change made outside
    // History (none is ever made without a step) could tell them apart.
    const docs = new Map(this.docs);
    for (const [path, d] of Object.entries(entry.docs)) {
      const cur = docs.get(path);
      if ((cur === undefined ? null : sha(cur)) !== d.after) return refuse(`${this.docName(path)} has changed since.`);
      if (d.before === null) docs.delete(path);
      else docs.set(path, await this.getBlob(d.before));
    }
    // The same gates as an Undo (see travel): a project that could not be saved or opened again is never made.
    const restored = collectionsFromDocs([...docs].filter(([p]) => collectionPathOf(p)).map(([p, c]) => [p, JSON.parse(c)]));
    if (restored.orphans.length) return refuse(`${restored.orphans[0]} would have no collection.`);
    if (restored.duplicates.length) return refuse(`${restored.duplicates[0]} would share its entry ID with another entry.`);
    // The documents it does not change are the very objects the project holds (shareUnchanged).
    const next = shareUnchanged(this.state, this.docs, docsToState(docs, this.state), docs);
    const pin = themePinProblem(next);
    if (pin) return refuse(pin);
    const problem = (why: string) => refuse(`Undoing it on its own would leave a problem: ${why}`);
    const synced = syncedEntryChange(this.state, next) ?? syncedDependencyLoss(this.state, next) ?? sourceIntegrityChange(this.state, next);
    if (synced) return refuse(`Undoing it on its own ${synced}`);
    // Anything the project would newly fail, warnings aside: a broken link is as much a reason as a page left out of
    // the page order.
    // A link to a draft is no problem of the project's: only the website export stops on it, and says so.
    const broken = introducedDiagnostics(this.problemsOf(this.state), this.problemsOf(next), { byNode: true }).filter((d) => d.severity === 'error' && !stopsExportOnly(d));
    if (broken.length) return problem(broken[0].message);
    // Links to a page that would be gone, counted rather than told apart by message, so one already broken nearby
    // never hides another.
    for (const id of Object.keys(this.state.pages)) {
      if (next.pages[id]) continue;
      const use = pageLinkUses(next, id)[0];
      if (use) return problem(`${use.where}: “${use.label}” links to ${this.state.pages[id].title}, which would no longer be there.`);
    }
    const gone = siteAddresses(this.state);
    for (const a of siteAddresses(next)) gone.delete(a);
    const url = ownUrlLinks(next, new Set([...gone].map((a) => a.toLowerCase())), siteBases(this.state.site, next.site))[0];
    if (url) return problem(`${url.where} links to ${url.url}, which would no longer be there.`);
    // A published page left linking to one the turn published, now a draft again, would stop the website export. A
    // typed address is read on the public URL the site has now too, when the turn is what set it. Told apart by where
    // the link is and where it goes, not by its words.
    const where = (l: { owner: object; nodeId: string; inText: boolean; pageId?: string; entryId?: string; anchor?: string }) => JSON.stringify([l.owner, l.nodeId, l.inText, l.pageId, l.entryId, l.anchor]);
    const stranded = new Set(publicationPlan(this.state).draftLinks.map(where));
    const withBase = next.site.baseUrl === this.state.site.baseUrl ? next : { ...next, site: { ...next.site, baseUrl: this.state.site.baseUrl } };
    const draft = [...publicationPlan(next).draftLinks, ...(withBase === next ? [] : publicationPlan(withBase).draftLinks)].find((l) => !stranded.has(where(l)));
    if (draft) return problem(`a published page would link to a draft${draft.label ? ` (“${draft.label}”)` : ''}, which stops the website export.`);
    // Code that needs a component the turn added, which nothing above reads.
    for (const id of Object.keys(this.state.components)) {
      if (next.components[id]) continue;
      const needs = Object.values(next.components).find((d) => codeNeeds(this.state, d, id));
      if (needs) return problem(`“${needs.name}” needs “${this.state.components[id].name}”, which this turn added.`);
    }
    // Code the turn changed comes back as it was, and must still build with the components there are now: one it
    // imported may have been deleted since. Only the site's own components are looked for; the rest of src/lib is
    // the app's, there whatever was undone.
    const resolve = componentSources(next.components);
    const generated = new Set(Object.values(next.components).map(defFile));
    const modules = (spec: string) => {
      // A Vite query (?raw) asks for the same file.
      const path = spec.replace(/[?#].*$/, '');
      if (path.startsWith('src/lib/siteorigin/custom/')) return resolve(path) !== undefined;
      // A component's generated file is there only while the component is; other generated modules are the app's.
      if (path.startsWith(`${GENERATED_DIR}/`) && path.includes('.svelte')) return generated.has(path);
      return true;
    };
    for (const def of Object.values(next.components)) {
      if (def.kind !== 'code' || def.source === undefined || def.source === this.state.components[def.id]?.source) continue;
      const bad = (await checkSvelteSource(def.source, { filename: def.sourcePath, resolve, modules })).filter((p) => p.severity === 'error');
      if (bad.length) return problem(`the code for “${def.name}” would have problems: ${bad[0].message}`);
    }
    // Nor may restored code close a loop with code changed since, a component that ends up rendering itself.
    const loop = componentCycle(next);
    if (loop && !componentCycle(this.state)) return problem(`${loop.map((id) => next.components[id]?.name ?? id).join(' → ')} would each render the next, without end.`);
    return { review, next, entry };
  }

  // -------------------------------------------------------------------------
  // AI runs
  // -------------------------------------------------------------------------

  beginRun(runId: string): Promise<string | null> {
    return this.serialize(timed('session.beginRun', async () => {
      if (this.activeRun) return 'Another AI request is already running.';
      if (!(await this.stillOwner())) return this.readOnly?.reason ?? LOCK_UNCHECKED;
      if (this.unsettled) return UNSETTLED;
      if (this.pending.size) return 'A project file was changed outside SiteOrigin Builder. Resolve it in Project health first.';
      const before = new Map(this.docs);
      // A state is never changed in place (src/engine/draft.ts): the one the run starts from is kept as it is.
      this.activeRun = { id: runId, before, beforeState: this.state, startRevision: this.revision, written: new Map(), hashes: new Map() };
      await this.writeRunMarker();
      return null;
    }));
  }

  /**
   * Record exactly which files the run has changed (or is about to change), with before and after hashes. Both name
   * stored blobs (a save stores its versions before this names them), so recovery can hold the pre-run version and
   * show the version the run last attempted.
   * `written` lists every version the run has put in each file, so a crash between writing this marker and
   * publishing the batch (the file still holds the previous batch) is still recognised as the run's own work.
   */
  private async writeRunMarker(docs: Map<string, string> = this.docs) {
    const run = this.activeRun;
    if (!run) return;
    const { marker, written } = await this.runMarker(run.before, docs);
    await atomicWrite(this.local('sessions', 'active-run.json'), toJson(marker));
    run.written = written;
  }

  /**
   * The active run's marker, were its checkpoint `before` and its documents `docs`, and the versions it lists as the
   * run's (`written`, for the run to take once the marker is on disk: a save turned away keeps none of its own). The
   * checkpoint's versions are stored before this returns, as a marker naming them may be written.
   */
  private async runMarker(before: Map<string, string>, docs: Map<string, string>): Promise<{ marker: RunMarker; written: ActiveRunInfo['written'] }> {
    const marking = perf.span('session.runMarker');
    const run = this.activeRun!;
    const paths: RunMarker['paths'] = {};
    const all = new Set([...before.keys(), ...docs.keys(), ...run.written.keys()]);
    const kept: ActiveRunInfo['written'] = new Map([...run.written].map(([p, w]) => [p, new Set(w)]));
    for (const path of all) {
      const b = before.get(path);
      const a = docs.get(path);
      const written = kept.get(path) ?? new Set<string | null>();
      // A document the run has not changed, nor written before, is not in the marker: it needs no hash.
      if (b === a && !written.size) continue;
      const after = a === undefined ? null : this.docHash(path, a);
      if (b !== a) written.add(after);
      if (written.size) kept.set(path, written);
      paths[path] = { before: b === undefined ? null : await this.putBlob(b), after, written: [...written] };
    }
    // Building the marker: every document hashed, the run's versions stored. Its write is not in the span.
    marking({ paths: Object.keys(paths).length });
    return { marker: { id: run.id, paths }, written: kept };
  }

  /** `text`'s SHA-256, worked out again only when the document at `path` holds other text than the run last hashed. */
  private docHash(path: string, text: string): string {
    const hashes = this.activeRun?.hashes;
    const kept = hashes?.get(path);
    if (kept?.text === text) return kept.hash;
    const hash = sha(text);
    perf.count('run.docsHashed');
    hashes?.set(path, { text, hash });
    return hash;
  }

  /** The text each part of a code component's code shows, by part, for an AI run limited to one part (#1416). */
  codePartTexts(source: string): ReturnType<typeof codePartTexts> {
    return codePartTexts(source);
  }

  /** Did the active run change anything? */
  runChanged(): boolean {
    if (!this.activeRun) return false;
    if (this.activeRun.before.size !== this.docs.size) return true;
    for (const [p, c] of this.docs) if (this.activeRun.before.get(p) !== c) return true;
    return false;
  }

  /**
   * Commit the run as one history group; `guestName` is the live-session guest it ran for (#769), if any.
   * `stillWanted` is asked before the run is decided and again as its journal is about to take its place, the moment
   * it is decided: false keeps the run open, so it is rolled back (abortRun), and throws a cancellation (a guest's access
   * taken away while it finished).
   */
  completeRun(label: string, guestName?: string, stillWanted?: () => boolean): Promise<boolean> {
    return this.serialize(async () => {
      const run = this.activeRun;
      if (!run) return false;
      // Another app took the project over, the lock could not be checked, or a save of the run did not finish:
      // reopening decides what happens to this run's files (its marker is still on disk), so nothing more is written.
      if (this.unsettled || !(await this.stillOwner())) {
        this.activeRun = null;
        if (!this.readOnly) this.unsettled = true;
        throw new Error(this.readOnly?.reason ?? UNSETTLED);
      }
      const changed: HistoryEntry['docs'] = {};
      const paths = new Set([...run.before.keys(), ...this.docs.keys()]);
      for (const p of paths) {
        const b = run.before.get(p);
        const a = this.docs.get(p);
        if (b === a) continue;
        changed[p] = { before: b === undefined ? null : await this.putBlob(b), after: a === undefined ? null : await this.putBlob(a) };
      }
      const planned = Object.keys(changed).length ? this.planHistory(changed, { label, source: 'ai', runId: run.id, ...(guestName ? { guestName } : {}) }, this.revision) : null;
      if (stillWanted && !stillWanted()) throw new Error('Canceled');
      // From here a failure is settled by reopening: recovery either finishes the run or restores its checkpoint.
      this.activeRun = null;
      let refused = false;
      try {
        if (planned) {
          // The journal is the decision. Before it is on disk, a crash restores the checkpoint (the marker is still
          // there); once it is, recovery records the run's step and clears the marker, so the finished work is kept.
          refused = !(await this.writeJournal({ writes: [], deletes: [], history: planned.history, revision: this.revision, finishRun: run.id }, stillWanted ? async () => stillWanted() : undefined));
        } else {
          // Nothing changed: restoring the checkpoint and keeping the run are the same thing.
          await removeDurable(this.local('sessions', 'active-run.json'));
        }
      } catch (e) {
        this.unsettled = true;
        throw e;
      }
      // Turned away at the moment of decision: nothing replaced the journal, and the run is open again to be rolled back.
      if (refused) {
        this.activeRun = run;
        throw new Error('Canceled');
      }
      if (planned) {
        try {
          await this.installHistory(planned.history);
          await removeDurable(this.local('sessions', 'active-run.json'));
          await removeDurable(this.local('journal.json'));
        } catch {
          // The run is decided and kept: reopening finishes recording it. Until then nothing else is written.
          this.unsettled = true;
          this.emit('history');
          return true;
        }
      }
      if (planned && (planned.pruned || --this.gcCountdown <= 0)) this.sweepSoon();
      this.emit('history');
      return !!planned;
    });
  }

  /** Restore the pre-run state (failure or cancellation). */
  abortRun(): Promise<{ restored: boolean; conflict?: string }> {
    return this.serialize(async () => {
      const run = this.activeRun;
      if (!run) return { restored: false };
      // As in completeRun: when this session cannot write, the marker stays and reopening restores the checkpoint.
      // A save of the run that failed part way leaves a journal that reopening rolls forward before that, so the
      // marker must survive it too.
      if (this.unsettled || !(await this.stillOwner())) {
        this.activeRun = null;
        if (!this.readOnly) this.unsettled = true;
        return { restored: false };
      }
      const touched = [...new Set([...run.before.keys(), ...this.docs.keys()])].filter((p) => run.before.get(p) !== this.docs.get(p));
      const changedOutside: string[] = [];
      this.activeRun = null;
      try {
        // Verify, byte for byte, that every file the run touched still holds what the run wrote.
        for (const p of touched) if ((await this.diskContent(p)) !== (this.docs.get(p) ?? null)) changedOutside.push(p);
        if (touched.length && !changedOutside.length) {
          try {
            await this.persist(run.beforeState, { label: 'Revert AI changes', history: false, source: 'system' });
          } catch (e) {
            if (!(e instanceof DiskConflictError)) throw e;
            changedOutside.push(e.path);
            // A collection's settings changed outside (a source attached): its entries the run wrote are held too,
            // never taken back under it.
            const settings = collectionPathOf(e.path);
            if (settings && settings.entryId === undefined)
              for (const p of touched) if (collectionPathOf(p)?.collectionId === settings.collectionId && collectionPathOf(p)?.entryId !== undefined) changedOutside.push(p);
          }
        }
        if (changedOutside.length) await this.revertAroundConflicts(run, touched, changedOutside);
        await removeDurable(this.local('sessions', 'active-run.json'));
      } catch (e) {
        // The marker may still be on disk: reopening restores the checkpoint, and nothing is written until then.
        this.unsettled = true;
        throw e;
      }
      this.emit('history');
      return changedOutside.length ? { restored: false, conflict: changedOutside[0] } : { restored: true };
    });
  }

  /**
   * Keep a source an AI run wrote or tried to write in the project's recovery folder (spec 14.3): a patch the checks
   * refused (`rejected`), or one that landed (`applied`), kept in case the run is reverted. Returns the file's
   * project-relative path, or null when nothing is written: a project open read-only, or a run that no longer holds it.
   */
  keepSourceDraft(runId: string, definitionId: string, source: string, kind: 'rejected' | 'applied'): Promise<string | null> {
    return this.serialize(async () => {
      if (this.readOnly || this.activeRun?.id !== runId || !RUN_ID.test(runId)) return null;
      // Named for the component and what was written, so the same source kept twice is one file.
      const name = definitionId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'component';
      const rel = `${LOCAL_DIR}/recovery/${SOURCE_DRAFTS}/${runId}/${kind}/${name}-${sha(`${definitionId}\0${source}`).slice(0, 12)}.svelte`;
      await atomicWrite(safeJoin(this.dir, rel), source);
      return rel;
    });
  }

  /**
   * Let go of the copies keepSourceDraft made of a finished run's patches that landed: the project has them now. Only
   * those files go; refused drafts stay, and so does anything else in the folder.
   */
  discardAppliedDrafts(runId: string, paths: string[]): Promise<void> {
    return this.serialize(async () => {
      if (this.readOnly || !RUN_ID.test(runId)) return;
      const run = `${LOCAL_DIR}/recovery/${SOURCE_DRAFTS}/${runId}`;
      for (const p of paths) if (p.startsWith(`${run}/applied/`) && !p.slice(run.length).split('/').includes('..')) await removeDurable(safeJoin(this.dir, p));
      // Emptied folders go too; one that still holds something stays.
      for (const dir of [`${run}/applied`, run]) await fs.rmdir(safeJoin(this.dir, dir)).catch(() => undefined);
    });
  }

  /**
   * Some files a cancelled run touched were changed outside the app. Every other file goes back to its pre-run
   * version; each changed file keeps its external version on disk, with the pre-run version held for the user to
   * choose (spec 18.5). The project's documents in memory are the pre-run state, which is always consistent.
   */
  private async revertAroundConflicts(run: NonNullable<ProjectSession['activeRun']>, touched: string[], changedOutside: string[]) {
    const changedFiles = await this.publishing(async () => {
      for (const p of touched) {
        const before = run.before.get(p) ?? null;
        const disk = await this.diskContent(p);
        // Checked again right before replacing it: a file saved elsewhere since the first check is held too.
        if (changedOutside.includes(p) || (disk !== before && disk !== (this.docs.get(p) ?? null))) {
          // What the run last wrote to it is kept beside the pre-run version, for the user to see what was at stake.
          const tried = this.docs.get(p);
          this.holdConflict(p, before, 'Changed outside SiteOrigin Builder during an AI run.', { attempted: tried === undefined ? { ref: null } : { ref: sha(tried), content: tried } });
          continue;
        }
        if (disk === before) continue;
        if (before === null) await this.removeCanonical(p);
        else await atomicWrite(safeJoin(this.dir, p), before);
        this.landing?.add(p);
      }
      this.state = run.beforeState;
      this.docs = new Map(run.before);
      await this.saveConflicts();
      return this.publishGenerated(false);
    });
    this.revision++;
    await this.saveLocalState();
    this.emit('changed', { revision: this.revision, changedDocs: touched, changedFiles, label: 'Revert AI changes', source: 'system' } satisfies SessionEvent);
  }

  // -------------------------------------------------------------------------
  // External changes
  // -------------------------------------------------------------------------

  /** Re-read canonical documents after an external edit, accepting them only when valid. */
  async reloadFromDisk(): Promise<{ ok: boolean; message?: string }> {
    // Every call counts, refused or not: a reload the app's own save set off is work even when it finds nothing.
    perf.count('session.reloadFromDisk');
    perf.mark('session.reloadFromDisk');
    return this.serialize(() => this.readBack());
  }

  /**
   * The file watch saw `paths` (project-relative) change. When each holds exactly what the app last left there, that
   * was the app's own save and nothing is read; otherwise the whole project is read again, as reloadFromDisk does.
   */
  reloadChanged(paths: Iterable<string>): Promise<{ ok: boolean; message?: string }> {
    const named = [...paths];
    return this.serialize(async () => {
      if (await this.ownSave(named)) return { ok: true };
      perf.count('session.reloadFromDisk');
      perf.mark('session.reloadFromDisk');
      return this.readBack();
    });
  }

  /**
   * Whether `paths` hold just what the app left at them, in a project this window holds and nothing waits on: each is a
   * document whose file reads as exactly its text, or a document's place with nothing there and none in the project. The
   * project's manifest, which no watch covers, is looked at too, as a full read would. Anything else (a file the app
   * does not keep, a folder, a held conflict, a format update due, an interrupted save) is for the full read to decide.
   */
  private async ownSave(paths: string[]): Promise<boolean> {
    // A refused outside edit is looked at again by the full read, whatever the watch named: only it can tell it settled.
    if (!paths.length || this.activeRun || this.readOnly || this.unsettled || this.migrationDue || this.migrationFailed || this.pending.size || this.refusedSources.size) return false;
    // A code component's file put back after it was missing (even empty) is read, so the project stops saying so.
    if (paths.some((p) => this.absentSources.has(p))) return false;
    // A lock taken over is noticed now, as any reload notices it.
    if (!(await this.stillOwner())) return false;
    try {
      for (const p of new Set([...paths, MANIFEST_FILE])) {
        const mine = this.docs.get(p);
        const abs = safeJoin(this.dir, p);
        if (mine === undefined) {
          if (!isCanonicalPath(p) || !(await absent(abs))) return false;
          continue;
        }
        const read = await readFileAt(abs);
        if (typeof read === 'string') return false;
        // Read as a full read reads it: text that cannot be stored as it is (a lone surrogate) is not what the file says.
        const text = read.bytes.toString('utf8');
        if (text === mine) continue;
        // The manifest is read whatever the watch named: one stored in another layout says the same when it parses the same.
        if (p !== MANIFEST_FILE || toJson(JSON.parse(text)) !== mine) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  private async readBack(): Promise<{ ok: boolean; message?: string }> {
    if (this.activeRun) return { ok: false, message: 'Busy' };
    if (this.readOnly) return this.reloadReadOnly();
    if (!(await this.stillOwner())) return this.readOnly ? this.reloadReadOnly() : { ok: false, message: LOCK_UNCHECKED };
    if (this.unsettled) return { ok: false, message: UNSETTLED };
    // A held conflict is settled outside the app when its file is put back to SiteOrigin Builder's version.
    let settled = false;
    let reheld = false;
    for (const [p, builder] of [...this.pending]) {
      const disk = await this.diskContent(p);
      if (!settledOnDisk(p, disk, builder)) {
        // A deleted code component's file put back with other code is that file changed outside the app, and one in
        // conflict deleted outside is a deleted file again (#1540).
        const held = this.conflicts.find((c) => c.path === p);
        const owner = builder === null ? undefined : this.codeOwnerOf(p);
        if (held?.deletedCode && disk !== null) {
          this.holdConflict(p, builder, 'Changed outside SiteOrigin Builder.');
          reheld = true;
        } else if (held && !held.deletedCode && !held.aiRun && owner && disk === null && (await absent(safeJoin(this.dir, p)))) {
          this.holdConflict(p, builder, DELETED_CODE_REASON, undefined, { definitionId: owner });
          reheld = true;
        }
        continue;
      }
      // What an AI request attempted is kept first, as when it is settled in Project health; held until it is.
      if (!(await this.saveAttempt(p).then(() => true, () => false))) continue;
      this.releaseConflict(p);
      settled = true;
    }
    if (settled || reheld) await this.saveConflicts();
    if (reheld) this.emit('history');
    let next: ProjectState;
    let migrated: boolean;
    let stored: ProjectState;
    let raw: Map<string, string>;
    try {
      // Files still in conflict are read as SiteOrigin Builder's version until the user chooses.
      const read = await readProject(this.dir, { overlay: this.pending });
      next = read.state;
      stored = read.stored;
      raw = read.raw;
      migrated = !!read.migration;
    } catch (e) {
      if (settled) this.emit('history');
      return { ok: false, message: (e as Error).message };
    }
    // A code component's file deleted outside the app (#1540) is held with the code last loaded, which the component
    // keeps meanwhile: the author puts the file back from it, or removes the component, in Project health. Told at once,
    // whatever becomes of the rest of what was read.
    if (await this.holdDeletedCode(next, raw)) {
      await this.saveConflicts();
      this.emit('history');
    }
    // Every component's edited code is checked, so each refused file is told of, and one put right is no longer. Edited
    // code that is fine but held back with the rest of the read is told of too, until it loads (#1533).
    const sources = await this.editedSources(next);
    const refusedCode = sources.filter((e) => e.problem);
    if (refusedCode.length) return this.refuseSources(sources, ', because other edited code has problems', { ok: false, message: refusedCode.map((e) => e.message).join(' ') });
    const errors = this.introducedProblems(next);
    if (errors.length) return this.refuseSources(sources, ' with the other changed files', { ok: false, message: errors.map((e) => e.message).join(' ') });
    const pin = themePinProblem(next);
    if (pin) return this.refuseSources(sources, ' with the other changed files', { ok: false, message: `The changed files were not loaded: ${pin}` });
    // A component put back from an older copy (or one from before a theme update) can lack an option placements
    // chose since: loading it would quietly show them its default instead.
    // Documents put back from before variant axes come with their own choices, converted (and checked) by that step.
    const older = (doc: { schemaVersion?: unknown } | undefined) => !!doc && formatOf(doc) < AXES_FORMAT;
    const lost = choicesLost(this.state, next, (owner) => {
      const [kind, id] = owner.split(/:(.*)/s);
      return older(kind === 'shell' ? stored.site : kind === 'page' ? stored.pages[id] : stored.components[id]);
    });
    if (lost.length) return this.refuseSources(sources, ' with the other changed files', { ok: false, message: `The changed files were not loaded: ${lost[0]} Put back the matching page files too, or choose another option first.` });
    this.migrationDue = migrated;
    // Frozen as it will be once it is the project, so its documents' texts are kept from here.
    const nextDocs = stateToDocs(frozen(next));
    let same = nextDocs.size === this.docs.size;
    if (same) for (const [p, c] of nextDocs) if (this.docs.get(p) !== c) same = false;
    const srcSame = JSON.stringify([...stateToAuthoredSources(next)]) === JSON.stringify([...stateToAuthoredSources(this.state)]);
    // Read and found sound: holds whose component has gone are let go, and which code components' files are missing
    // follows what was read (#1540), said at once when only that changed.
    const dropped = await this.reconcileHolds(next);
    if (dropped) await this.saveConflicts();
    const absentBefore = [...this.absentSources].sort().join('\n');
    this.noteAbsentSources(next, raw);
    if (dropped || [...this.absentSources].sort().join('\n') !== absentBefore) this.emit('history');
    if (same && srcSame) {
      // Every document read to find nothing changed: what a reload set off by the app's own save costs.
      if (!this.migrationDue && !settled) {
        perf.count('session.reloadUnchanged');
        perf.mark('session.reloadUnchanged');
      }
      // Only the stored format differs (a file put back from an older copy): store it in the current one.
      if (this.migrationDue && !this.pending.size) await this.publishMigration(3, this.state);
      // Nothing changed: a refused file was put back as it was loaded. Cleared before a settled conflict tells of it.
      this.setRefusedSources(new Map(), { quiet: settled });
      if (settled) this.emit('changed', { revision: this.revision, changedDocs: [], changedFiles: [], label: 'Conflict resolved', source: 'system' } satisfies SessionEvent);
      return { ok: true };
    }
    // Treat the external change as a normal committed edit.
    // Accept the external change as a normal committed edit. The cache is updated to what is on disk
    // so the history entry records the correct before and after.
    const prevDocs = this.docs;
    const changed: HistoryEntry['docs'] = {};
    for (const p of new Set([...prevDocs.keys(), ...nextDocs.keys()])) {
      const b = prevDocs.get(p);
      const a = nextDocs.get(p);
      // The record of what was exported is loaded, never a step of History: no undo takes back what was published.
      if (b === a || p === PUBLISHED_FILE) continue;
      changed[p] = { before: b === undefined ? null : await this.putBlob(b), after: a === undefined ? null : await this.putBlob(a) };
    }
    // Read again from the files, every document is a new object: those that read the same are the project's own.
    this.state = shareUnchanged(this.state, prevDocs, next, nextDocs);
    this.docs = nextDocs;
    const changedFiles = await this.publishInstalled();
    this.revision++;
    if (Object.keys(changed).length) await this.recordHistory(changed, { label: 'External change', source: 'system' });
    await this.saveLocalState();
    if (this.migrationDue && !this.pending.size) await this.publishMigration(3, this.state);
    // The edited code is loaded: its notices go with the change that brings it, never in a snapshot of their own. Kept
    // until then, so a step above that fails leaves them for the next read to clear, and tell of.
    this.setRefusedSources(new Map(), { quiet: true });
    this.emit('changed', { revision: this.revision, changedDocs: Object.keys(changed), changedFiles, label: 'External change', source: 'system' } satisfies SessionEvent);
    return { ok: true };
  }

  /**
   * The code components of `next` whose source differs from the project's, each with its file and its first error if it
   * has one. Inline code (a theme's component) is in the component's document.
   */
  private async editedSources(next: ProjectState): Promise<EditedSource[]> {
    const edited: EditedSource[] = [];
    for (const def of Object.values(next.components)) {
      if (def.kind !== 'code' || def.source === this.state.components[def.id]?.source) continue;
      const problem = (await checkSvelteSource(def.source ?? '')).find((p) => p.severity === 'error');
      const path = def.sourcePath ?? componentDocPath(def.id);
      const where = problem?.line ? `${path}, line ${problem.line}${def.sourcePath ? '' : ' of its source'}` : path;
      edited.push({ id: def.id, name: def.name, path, problem: !!problem, message: problem ? `The edited code for "${def.name}" has problems, so it was not loaded (${where}): ${problem.message}` : '' });
    }
    return edited;
  }

  /**
   * A read of `sources` refused (`result`): those with errors stand as refusals, and the rest are held back with them,
   * `why` finishing "it waits…".
   */
  private refuseSources(sources: EditedSource[], why: string, result: { ok: false; message: string }) {
    const standing = new Map<string, RefusedSource>();
    for (const e of sources)
      standing.set(e.id, e.problem ? { path: e.path, message: e.message } : { path: e.path, message: `The edited code for "${e.name}" (${e.path}) has not loaded yet: it waits${why}. ${result.message}`, held: true });
    this.setRefusedSources(standing);
    return result;
  }

  /** Keep `standing` as the refusals, telling (`refused-sources`) of a change unless a snapshot of the read tells it. */
  private setRefusedSources(standing: Map<string, RefusedSource>, opts: { quiet?: boolean } = {}) {
    const before = JSON.stringify([...this.refusedSources]);
    this.refusedSources = standing;
    if (!opts.quiet && JSON.stringify([...standing]) !== before) this.emit('refused-sources');
  }

  /**
   * The outside edits of code components refused for their errors (and those held back with them, as warnings), as
   * Project health and the source editor show them.
   */
  refusedSourceDiagnostics(): Diagnostic[] {
    return [...this.refusedSources].map(([id, r]) => ({ severity: r.held ? 'warning' : 'error', code: EXTERNAL_SOURCE_REFUSED, message: r.message, owner: { kind: 'component', id }, site: r.path }));
  }

  /**
   * Hold each project code component's file that `next` (just read, its documents' texts in `raw`) finds gone, where
   * the project had loaded code from it: the hold keeps that code, which `next` takes too. A file that cannot be read
   * just now is not taken as gone.
   */
  private async holdDeletedCode(next: ProjectState, raw: Map<string, string>): Promise<boolean> {
    let held = false;
    for (const def of Object.values(next.components)) {
      if (def.kind !== 'code' || def.owner !== 'project' || !def.sourcePath || raw.has(def.sourcePath) || this.pending.has(def.sourcePath) || this.absentSources.has(def.sourcePath)) continue;
      const loaded = Object.hasOwn(this.state.components, def.id) ? this.state.components[def.id] : undefined;
      if (loaded?.sourcePath !== def.sourcePath || loaded.source === undefined) continue;
      if (!(await absent(safeJoin(this.dir, def.sourcePath)))) continue;
      this.holdConflict(def.sourcePath, loaded.source, DELETED_CODE_REASON, undefined, { definitionId: def.id });
      def.source = loaded.source;
      held = true;
    }
    return held;
  }

  /**
   * Holds on project code components' files, squared with `state` (#1540): a deleted file's hold whose component no
   * longer has that file is let go (History keeps the code, as a removal's step does), and a changed file's hold whose
   * file is gone again is a deleted file's. Holds an AI request left are its own.
   */
  private async reconcileHolds(state: ProjectState): Promise<boolean> {
    let changed = false;
    for (const c of [...this.conflicts]) {
      const builder = this.pending.get(c.path);
      if (c.kind !== 'canonical' || c.aiRun || builder === undefined || builder === null) continue;
      if (c.deletedCode) {
        const def = Object.hasOwn(state.components, c.deletedCode.definitionId) ? state.components[c.deletedCode.definitionId] : undefined;
        if (def?.sourcePath === c.path) continue;
        this.releaseConflict(c.path);
        changed = true;
        continue;
      }
      const owner = Object.values(state.components).find((d) => d.kind === 'code' && d.owner === 'project' && d.sourcePath === c.path);
      if (owner && (await absent(safeJoin(this.dir, c.path)))) {
        this.holdConflict(c.path, builder, DELETED_CODE_REASON, undefined, { definitionId: owner.id });
        changed = true;
      }
    }
    return changed;
  }

  /** The project code component whose file `path` is, in the project as loaded. */
  private codeOwnerOf(path: string): string | undefined {
    return Object.values(this.state.components).find((d) => d.kind === 'code' && d.owner === 'project' && d.sourcePath === path)?.id;
  }

  /** Which code components' files `state`, read with its documents' texts in `raw`, found missing (#1540). */
  private noteAbsentSources(state: ProjectState, raw: Map<string, string>) {
    this.absentSources = new Set(Object.values(state.components).flatMap((d) => (d.kind === 'code' && d.owner === 'project' && d.sourcePath && !raw.has(d.sourcePath) && !this.pending.has(d.sourcePath) ? [d.sourcePath] : [])));
  }

  /** Read-only inspection follows the owner's edits without writing anything. */
  private async reloadReadOnly(): Promise<{ ok: boolean; message?: string }> {
    // A project only inspected loads whatever its owner keeps: nothing it shows is a refused edit of this window's.
    this.setRefusedSources(new Map());
    let next: ProjectState;
    let raw: Map<string, string>;
    try {
      ({ state: next, raw } = await readProject(this.dir, { allowNewer: true }));
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    // Which code components' files are missing is followed too, and said as soon as it changes.
    const absentBefore = [...this.absentSources].sort().join('\n');
    this.noteAbsentSources(next, raw);
    if ([...this.absentSources].sort().join('\n') !== absentBefore) this.emit('history');
    const nextDocs = stateToDocs(frozen(next));
    if (nextDocs.size === this.docs.size && [...nextDocs].every(([p, c]) => this.docs.get(p) === c)) {
      perf.count('session.reloadUnchanged');
      perf.mark('session.reloadUnchanged');
      return { ok: true };
    }
    const changedDocs = [...new Set([...nextDocs.keys(), ...this.docs.keys()])].filter((p) => nextDocs.get(p) !== this.docs.get(p));
    this.state = shareUnchanged(this.state, this.docs, next, nextDocs);
    this.docs = nextDocs;
    this.revision++;
    this.emit('changed', { revision: this.revision, changedDocs, changedFiles: [], label: 'External change', source: 'system' } satisfies SessionEvent);
    return { ok: true };
  }

  async close() {
    // A starting version still being saved stops at its next file, and its Git write at once: closing never waits for a
    // whole library.
    this.leaving = true;
    this.leavingAbort.abort();
    // A sweep not yet run is left to the next open, which sweeps first.
    if (this.sweepTimer) clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
    await this.writing.catch(() => undefined);
    await this.releaseLock();
    this.removeAllListeners();
    this.generation.clear();
    this.seenOnDisk.clear();
    this.contentHashes.clear();
    this.siteIcons.clear();
  }
}

// ---------------------------------------------------------------------------
// Project lock
// ---------------------------------------------------------------------------

interface LockFile {
  pid?: number;
  host?: string;
  instance?: string;
  token?: string;
  started?: string;
}
interface LockSeen {
  text: string;
  mtimeMs: number;
}

/** An unreadable lock is most likely one being written; it is only stale once it has stayed that way this long. */
const UNREADABLE_LOCK_STALE_MS = 10_000;
/** How long an unlock waits for the owner's own claim before taking it as left by a crash part way through a command. */
const OWNER_CLAIM_GRACE_MS = 5_000;
/** The generation shown for a project with no lock at all: an unlock then only creates one, never replaces one. */
export const NO_LOCK = 'none';

/**
 * What this app has seen of locks it could not judge by its own clock, with when it first saw each unchanged
 * (on this process's monotonic clock). Another computer's clock may be minutes or hours away from this one, so its
 * lock times are never compared with this clock; only whether they change.
 */
const sightings = new Map<string, { key: string; since: number }>();
function unchangedFor(path: string, seen: LockSeen): number {
  const key = `${seen.mtimeMs}\0${seen.text}`;
  const now = performance.now();
  const prior = sightings.get(path);
  if (prior?.key === key) return now - prior.since;
  sightings.set(path, { key, since: now });
  return 0;
}

function parseLock(text: string): LockFile | null {
  try {
    const l = JSON.parse(text) as unknown;
    return l && typeof l === 'object' && !Array.isArray(l) ? (l as LockFile) : null;
  } catch {
    return null;
  }
}

/** The lock's content and time, read through one handle so they belong to the same file. */
async function readLock(path: string): Promise<LockSeen | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(path, 'r');
    const st = await handle.stat();
    return { text: await handle.readFile('utf8'), mtimeMs: st.mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const sameLock = (a: LockSeen | null, b: LockSeen) => !!a && a.text === b.text && a.mtimeMs === b.mtimeMs;

async function createExclusive(path: string, body: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  try {
    await handle.writeFile(body);
  } catch (e) {
    // Never leave behind an empty file that others would take for a live lock or claim.
    await handle.close().catch(() => undefined);
    await fs.rm(path, { force: true }).catch(() => undefined);
    throw e;
  }
  await handle.close();
  return true;
}

/** Which acquisition of the lock this is: its token, or for a lock without one, its exact content. */
function lockGeneration(seen: LockSeen): string {
  const token = parseLock(seen.text)?.token;
  return typeof token === 'string' && /^[a-f0-9]{1,64}$/.test(token) ? token : sha(seen.text).slice(0, 16);
}

/** Is a process on this computer alive? Only "no such process" says it is gone; a refusal (another user's) is alive. */
function processAlive(pid: unknown): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function judgeLock(path: string, seen: LockSeen, instanceId: string, force: boolean | string): { stale: boolean; owner: LockOwner; generation: string } {
  const l = parseLock(seen.text);
  const generation = lockGeneration(seen);
  const owner: LockOwner = l
    ? { host: l.host === hostname() ? 'this computer' : String(l.host || 'another computer'), since: l.started, token: generation }
    : { host: 'another computer', token: generation };
  // An unlock takes over the generation the user was shown, and nothing else: not a newer owner, not this app's own.
  if (typeof force === 'string') return { stale: generation === force, owner, generation };
  if (force === true) return { stale: true, owner, generation };
  // Unreadable: possibly another opener between creating the file and writing it.
  if (!l) return { stale: unchangedFor(path, seen) > UNREADABLE_LOCK_STALE_MS, owner, generation };
  if (l.instance === instanceId) return { stale: true, owner, generation };
  // A process on this computer that is gone holds nothing. Otherwise (a live process, perhaps a reused PID, or
  // another computer, or this one under an old name) the lock is stale only once it has stopped changing for long
  // enough on this app's own clock: lock times are never compared with it.
  if (l.host === hostname() && !processAlive(l.pid)) return { stale: true, owner, generation };
  return { stale: unchangedFor(path, seen) > LOCK_STALE_MS, owner, generation };
}

/**
 * Remove a lock or claim file only if it is still exactly what was seen: it is moved aside first, and anything else
 * found there (created exclusively since) goes straight back.
 */
async function removeIfUnchanged(path: string, seen: LockSeen): Promise<boolean> {
  const aside = `${path}.${randomBytes(4).toString('hex')}.stale`;
  try {
    await fs.rename(path, aside);
  } catch {
    return false;
  }
  const moved = sameLock(await readLock(aside).catch(() => null), seen);
  if (!moved) await fs.link(aside, path).catch(() => undefined);
  await fs.rm(aside, { force: true });
  return moved;
}

/**
 * Claim one generation of the lock: its owner holds the claim while it writes, a taker while it takes over, and only
 * one claim can be live. Claims are numbered files (lock.json.<generation>.claim.<n>), each created exclusively; the
 * highest is the live one. A claim left by an app that stopped part way is never moved or deleted by anyone else:
 * once it is judged dead it is passed over by exclusively creating the next number, so two claimants can never both
 * win, and each claimant only ever removes its own file. `holder` is the claimant's own lock token. Waits up to
 * `waitMs` for a live claim. A claim is dead once its process is provably gone, once it has not changed for the stale
 * period, or (`ownerGone`, an unlock) once a claim the owner of that generation left has sat unchanged for longer
 * than any command takes.
 */
async function claimLock(lockPath: string, generation: string, opts: { holder: string; waitMs?: number; ownerGone?: boolean }): Promise<string | null> {
  const dir = dirname(lockPath);
  const prefix = `${basename(lockPath)}.${generation}.claim.`;
  const body = toJson({ pid: process.pid, host: hostname(), holder: opts.holder, started: new Date().toISOString() });
  const until = performance.now() + (opts.waitMs ?? 0);
  for (;;) {
    const taken = (await fs.readdir(dir).catch(() => [] as string[]))
      .filter((f) => f.startsWith(prefix))
      .map((f) => Number(f.slice(prefix.length)))
      .filter((n) => Number.isInteger(n) && n > 0);
    const top = taken.length ? Math.max(...taken) : 0;
    let next = top + 1;
    if (top) {
      const path = join(dir, `${prefix}${top}`);
      const seen = await readLock(path).catch(() => null);
      if (!seen) next = top; // released just now: that number is free again
      else {
        const l = parseLock(seen.text) as (LockFile & { holder?: unknown }) | null;
        const quiet = unchangedFor(path, seen);
        const dead = (l?.host === hostname() && !processAlive(l.pid)) || (opts.ownerGone && l?.holder === generation && quiet > OWNER_CLAIM_GRACE_MS) || quiet > LOCK_STALE_MS;
        if (!dead) next = 0;
      }
    }
    if (next && (await createExclusive(join(dir, `${prefix}${next}`), body))) return join(dir, `${prefix}${next}`);
    if (performance.now() >= until) return null;
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Claims on a generation that has just been replaced are of no further use to anyone. */
async function removeClaims(lockPath: string, generation: string) {
  const dir = dirname(lockPath);
  const prefix = `${basename(lockPath)}.${generation}.claim.`;
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) if (f.startsWith(prefix)) await fs.rm(join(dir, f), { force: true }).catch(() => undefined);
}

/** The version an AI request tried to save, held beside its conflict: its blob (null = removed) and its text once read. */
interface Attempt {
  ref: string | null;
  content?: string;
  /** Its blob is gone or damaged, so there is nothing left to show or keep. */
  lost?: boolean;
}

/** An attempted version named by a run marker or a conflict list: null for a removal, undefined when unusable. */
function attemptAt(ref: unknown): Attempt | undefined {
  if (ref === null) return { ref: null };
  return typeof ref === 'string' && /^[a-f0-9]{64}$/.test(ref) ? { ref } : undefined;
}

/** A held conflict is settled when the file on disk is Builder's version again: present or absent alike. */
function settledOnDisk(path: string, disk: string | null, builder: string | null): boolean {
  return (disk === null) === (builder === null) && sameContent(path, disk, builder);
}

/** Refuse to open a project written by a newer version for editing (it can still be opened read-only). */
async function assertKnownFormat(dir: string, read?: DocReader) {
  // Every document file is scanned on its own: the full read stops at the first broken document, which may sort before
  // a newer one, and it keys documents by id, which a crafted id can hide. The scan looks at every document the read
  // takes, and judges each one's format as the read does, so the read finds nothing newer that the scan let through.
  // Anything else wrong with the documents is reported by the normal open, after recovery has had its chance.
  const newest = await newestStoredVersion(dir, read);
  if (newest > SCHEMA_VERSION) throw new ProjectFormatError(`This project was created by a newer version of SiteOrigin Builder (format ${newest}). Update the app to edit it.`, true);
  // An interrupted save from a newer version is that version's to finish: replaying it here would write its format.
  const journal = await readIfExists(join(dir, LOCAL_DIR, 'journal.json'));
  let version: unknown;
  try {
    version = journal ? JSON.parse(journal).schemaVersion : undefined;
  } catch {
    return; // recovery sets an unreadable journal aside
  }
  if (typeof version === 'number' && version > SCHEMA_VERSION)
    throw new ProjectFormatError(`This project has an unfinished save from a newer version of SiteOrigin Builder (format ${version}). Update the app to edit it.`, true);
}

const COMPONENT_DOC_RE = /^siteorigin\/components\/[^/]+\/component\.json$/;

/** A history file from a journal that is well formed and in a format no newer than this app's. */
function readableJournalHistory(h: unknown): h is HistoryFile {
  if (!h || typeof h !== 'object') return false;
  const { entries, cursor, schemaVersion } = h as Partial<HistoryFile>;
  return typeof schemaVersion === 'number' && schemaVersion <= SCHEMA_VERSION && Array.isArray(entries) && Number.isInteger(cursor) && cursor! >= 0 && cursor! <= entries.length;
}

/** A history file from a journal is installed only when it is well formed and in this format: undo steps hold whole documents. */
function usableJournalHistory(h: unknown): h is HistoryFile {
  return readableJournalHistory(h) && h.schemaVersion === SCHEMA_VERSION;
}

/** The collections whose documents, among `steps`, only restores of saved versions change (HistoryEntry.restore). */
function restoredOnly(steps: HistoryEntry[]): Set<string> {
  const [restored, edited] = [new Set<string>(), new Set<string>()];
  for (const step of steps)
    for (const path of Object.keys(step.docs)) {
      const c = collectionPathOf(path)?.collectionId;
      if (c) (step.restore ? restored : edited).add(c);
    }
  for (const c of edited) restored.delete(c);
  return restored;
}

function emptyHistory(): HistoryFile {
  return { schemaVersion: SCHEMA_VERSION, entries: [], cursor: 0 };
}

/**
 * Undo steps hold whole documents, so they are only usable in the format they were written in. History from an
 * older format is dropped when it is read, which also covers a crash partway through updating the project.
 */
function usableHistory(file: HistoryFile | null): HistoryFile {
  if (file && file.schemaVersion === SCHEMA_VERSION) return file;
  const h = emptyHistory();
  // An older format's steps go, but where each AI step stood when they went is still true of the site, so its chat
  // turn keeps it (issue 276). A newer format, or an undo position that does not fit its steps, says nothing sure.
  const older = !!file && typeof file === 'object' && olderFormat(file.schemaVersion);
  if (older && Array.isArray(file.entries) && Number.isInteger(file.cursor) && file.cursor >= 0 && file.cursor <= file.entries.length) {
    const before = file.droppedRuns && typeof file.droppedRuns === 'object' && !Array.isArray(file.droppedRuns) ? Object.entries(file.droppedRuns) : [];
    for (const [runId, status] of before) if (status === 'applied' || status === 'undone') noteDropped(h, [{ runId } as HistoryEntry], status);
    // By each step's own place: a malformed one is skipped where it stands, never moving another across the cursor.
    noteDropped(h, file.entries.slice(0, file.cursor), 'applied');
    noteDropped(h, file.entries.slice(file.cursor), 'undone');
  }
  return h;
}

/** History as it stands, as a review is worked out at: its steps and where it is among them. */
function historyKey(h: HistoryFile): string {
  return `${h.cursor}:${h.entries.map((e) => e.id).join(',')}`;
}

/** A format version before this one: the first format had none. */
function olderFormat(v: unknown): boolean {
  return v === undefined || (Number.isInteger(v) && (v as number) > 0 && (v as number) < SCHEMA_VERSION);
}

/**
 * Note in `h` each AI step of `dropped`, which History is letting go, as standing `status` (see HistoryFile.droppedRuns).
 * A step that took an AI run back on its own (issue 164) and goes while applied leaves that run undone; one let go
 * undone took nothing back, so its run stands as its own step or note says.
 */
function noteDropped(h: HistoryFile, dropped: Array<HistoryEntry | null | undefined>, status: DroppedRun) {
  const runs = dropped.flatMap((e): Array<[string, DroppedRun]> => {
    if (!e || typeof e !== 'object') return [];
    if (typeof e.runId === 'string' && e.runId) return [[e.runId, status]];
    return status === 'applied' && typeof e.revertsRunId === 'string' && e.revertsRunId ? [[e.revertsRunId, 'undone']] : [];
  });
  if (!runs.length) return;
  const map: Record<string, DroppedRun> = { ...h.droppedRuns };
  // In History's order, so a revert let go with the run it took back has the last word.
  for (const [runId, standing] of runs) {
    // The newest standing goes last, so the oldest are the first let go past the limit.
    delete map[runId];
    map[runId] = standing;
  }
  const ids = Object.keys(map);
  for (const runId of ids.slice(0, Math.max(0, ids.length - DROPPED_RUN_LIMIT))) delete map[runId];
  h.droppedRuns = map;
}

/** Compare disk content with the expected document, ignoring JSON formatting and treating a missing authored source as empty. */
/** The list of saved copies, in the recovery folder beside them. */
const SAVED_COPIES = 'copies.json';
/** The largest version shown as text when comparing or reading a saved copy. */
const TEXT_LIMIT = 512 * 1024;

function isSavedCopy(c: unknown): c is SavedCopy {
  const o = c as Record<string, unknown> | null;
  return (
    !!o &&
    typeof o.id === 'string' &&
    /^[0-9a-f]{16}$/.test(o.id) &&
    typeof o.path === 'string' &&
    (o.kind === 'canonical' || o.kind === 'generated') &&
    (o.side === 'external' || o.side === 'builder' || o.side === 'attempted') &&
    typeof o.savedAt === 'number' &&
    Number.isFinite(o.savedAt) &&
    typeof o.file === 'string' &&
    (o.removed === undefined || o.removed === true) &&
    // Only a file directly in the recovery folder: never a path that leads anywhere else.
    /^\.siteorigin\/recovery\/[A-Za-z0-9._-]+$/.test(o.file) &&
    !o.file.endsWith(`/${SAVED_COPIES}`)
  );
}

/** A version of a file as text to show, or why it is not shown: too large, or not text (a font, an image). */
function textOf(content: string | Buffer): FileText {
  if (typeof content === 'string') return Buffer.byteLength(content) > TEXT_LIMIT ? { state: 'too-large' } : { state: 'text', text: content };
  if (content.length > TEXT_LIMIT) return { state: 'too-large' };
  const text = content.toString('utf8');
  if (content.includes(0) || !Buffer.from(text, 'utf8').equals(content)) return { state: 'binary' };
  return { state: 'text', text };
}

/** A file as text to show; one too large to show is never read whole. */
async function readText(abs: string): Promise<FileText> {
  const size = await fs.stat(abs).then(
    (st) => st.size,
    () => 0
  );
  if (size > TEXT_LIMIT) return { state: 'too-large' };
  const read = await readFileAt(abs);
  if (read === 'missing') return { state: 'missing' };
  if (read === 'failed' || read === 'changed') return { state: 'unreadable' };
  return textOf(read.bytes);
}

/** Whether a document on disk says what the project holds: the same text, or for JSON the same value however it is laid out. */
export function sameContent(path: string, disk: string | null, expected: string | null): boolean {
  if (disk === expected) return true;
  if (path.endsWith('.json')) {
    if (disk === null) return expected === null || path === 'siteorigin/theme-lock.json';
    if (expected === null) return false;
    try {
      return toJson(JSON.parse(disk)) === toJson(JSON.parse(expected));
    } catch {
      return false;
    }
  }
  return (disk ?? '') === (expected ?? '');
}

/** Whether two document maps hold the same documents with the same text, `except` one path. */
/**
 * How many of `next`'s canonical documents are not the very objects `prev` holds: the documents a change copied (or
 * made). Only for the timing marks (src/shared/perf.ts).
 */
function docsCopied(prev: ProjectState, next: ProjectState): number {
  let n = 0;
  const one = (a: unknown, b: unknown) => {
    if (b !== undefined && a !== b) n++;
  };
  const each = <T>(a: Record<string, T> | undefined, b: Record<string, T> | undefined, fn: (x: T | undefined, y: T) => void) => {
    for (const k of Object.keys(b ?? {})) fn(a && Object.hasOwn(a, k) ? a[k] : undefined, b![k]);
  };
  for (const k of ['manifest', 'site', 'tokens', 'assets', 'themeLock', 'brief', 'published'] as const) one(prev[k], next[k]);
  each(prev.pages, next.pages, one);
  each(prev.components, next.components, one);
  each(prev.sources, next.sources, one);
  each(prev.collections, next.collections, (a, b) => {
    one(a?.settings, b.settings);
    each(a?.entries, b.entries, one);
  });
  return n;
}

function sameDocs(a: Map<string, string>, b: Map<string, string>, except?: string): boolean {
  for (const p of new Set([...a.keys(), ...b.keys()])) if (p !== except && a.get(p) !== b.get(p)) return false;
  return true;
}

/** `state` with `published` as its record of exported addresses (none when it is undefined). */
function withRecord(state: ProjectState, published: PublishedDoc | undefined): ProjectState {
  const next = { ...state };
  if (published) next.published = published;
  else delete next.published;
  return next;
}

/** Rebuild state from a document map (used by undo/redo). */
function docsToState(docs: Map<string, string>, current: ProjectState): ProjectState {
  const parse = <T>(p: string): T | undefined => (docs.has(p) ? (JSON.parse(docs.get(p)!) as T) : undefined);
  const next: ProjectState = {
    manifest: parse('siteorigin.project.json') ?? current.manifest,
    site: parse('siteorigin/site.json') ?? current.site,
    tokens: parse('siteorigin/tokens.json') ?? current.tokens,
    assets: parse('siteorigin/assets.json') ?? current.assets,
    themeLock: parse('siteorigin/theme-lock.json') ?? current.themeLock,
    pages: {},
    components: {},
    collections: collectionsFromDocs([...docs].filter(([p]) => collectionPathOf(p)).map(([p, c]) => [p, JSON.parse(c)])).collections
  };
  // Sources the documents lack are none: a deleted one stays deleted across undo and redo.
  const sources = sourcesFromDocs([...docs].filter(([p]) => sourcePathOf(p) !== null || converterPathOf(p) !== null));
  if (Object.keys(sources).length) next.sources = sources;
  // A brief the documents lack is none: it is only a file while it holds something.
  const brief = parse<ProjectBriefDoc>(BRIEF_FILE);
  if (brief) next.brief = brief;
  const published = parse<PublishedDoc>(PUBLISHED_FILE);
  if (published) next.published = published;
  for (const [p, c] of docs) {
    const pm = p.match(/^siteorigin\/pages\/(.+)\.json$/);
    if (pm) next.pages[pm[1]] = JSON.parse(c);
    const cm = p.match(/^siteorigin\/components\/(.+)\/component\.json$/);
    if (cm) {
      const def = JSON.parse(c);
      if (def.sourcePath) def.source = docs.get(def.sourcePath) ?? current.components[def.id]?.source ?? '';
      next.components[def.id] = def;
    }
  }
  return next;
}

export { readJson };
