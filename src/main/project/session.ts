import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs, constants as fsConstants, existsSync, type BigIntStats, type Dirent } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { PageDoc, ProjectState } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import type { ApplyResult, EditBatch, EditOperation } from '@shared/ops';
import type { FileText, RestoreVersionResult, SavedCopy, StorageInfo, VersionReview, VersionsInfo } from '@shared/api';
import { validateOperation } from '@shared/ops';
import { choicesLost } from '@shared/variants';
import { AXES_FORMAT, formatOf } from '@shared/migrations';
import { applyOperations, assetUsages, captureClipboard, type Clipboard } from '@engine/apply';
import { listThemes, themePinProblem } from '@catalogue/index';
import { anchorsInUse, displayName, EngineError } from '@engine/tree';
import { findRemoval, restoreRemoval } from '@engine/restore';
import { blocksSaving, diagnosticKey, introducedDiagnostics, validateState, type Diagnostic } from '@engine/validate';
import { developerModeRefusal } from '@engine/developer-mode';
import { findMissingAssetFiles } from './asset-files';
import type { MissingAssetFiles } from '@shared/api';
import { DOCUMENT_EXTENSIONS } from '@shared/document-files';
import { defFile, generateProject, GENERATOR_VERSION, packFileCopies, SERVER_HOOK_FILE } from '@generator/index';
import type { ComponentImport } from '@engine/component-package';
import { GenerationCache } from '@generator/cache';
import { themeUpdates, type ThemeUpdates } from '@engine/theme-updates';
import { packFileInfo, readPackFile } from '../packs/files';
import { ownServerHook } from './server-hook';
import { checkSvelteSource, componentSources } from '../codecheck';
import { atomicWrite, ensureDir, readBytesIfExists, readIfExists, readJson, removeDurable, removeEmptyDirs, safeJoin, sha, syncDir, toJson } from './fsutil';
import { collectionPathOf, collectionsFromDocs, CUSTOM_SOURCE_RE, DOC_DIR, isCanonicalPath, newestStoredVersion, ProjectFormatError, readProject, readState, stateToAuthoredSources, stateToDocs } from './documents';
import { heldAsMedia, isVersionMedia, newVersionId, sameContents, VERSION_DAMAGED, VERSION_NAME_MAX, VersionStore, type SavedVersion } from './versions';

export const LOCAL_DIR = '.siteorigin';
/** In the dev cache: hashes of the generated project files the dev variants stand in for. */
export const CLEAN_HASHES = '.clean-hashes.json';

/**
 * `fn` over every item, a few at a time: enough to overlap the disk's waits, never so many open files that one fails
 * to open (and an unreadable file would look like a missing one).
 */
async function inBatches<T, R>(items: T[], fn: (item: T) => Promise<R> | R, size = 16): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

/** What a generated file that is there but cannot be read hashes to: never ours, never missing. */
const UNREADABLE = 'unreadable';
const UNREADABLE_REASON = 'Generated file could not be read, so SiteOrigin Builder left it as it is. Check that it is a file you can open, then restore it.';

/** Opened for reading without waiting: a pipe at the path must never hold a save up. */
const OPEN_READ = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

/** The path's stat, or whether nothing is there or it could not be looked at. */
async function lookAt(abs: string): Promise<BigIntStats | 'missing' | 'failed'> {
  try {
    return await fs.stat(abs, { bigint: true });
  } catch (e) {
    return isMissing(e) ? 'missing' : 'failed';
  }
}

/** A regular file's bytes, read through one handle, with that handle's stat; 'changed' when it changed while read. */
async function readFileAt(abs: string): Promise<{ bytes: Buffer; stamp: string } | 'missing' | 'failed' | 'changed'> {
  let handle: FileHandle;
  try {
    handle = await fs.open(abs, OPEN_READ);
  } catch (e) {
    return isMissing(e) ? 'missing' : 'failed';
  }
  try {
    const before = await handle.stat({ bigint: true });
    // Only a regular file is read: a pipe or device could block, or never end.
    if (!before.isFile()) return 'failed';
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    return stampOf(after) === stampOf(before) ? { bytes, stamp: stampOf(before) } : 'changed';
  } catch {
    return 'failed';
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Nothing at all is at the path: not a file that merely cannot be looked at now. */
async function absent(abs: string): Promise<boolean> {
  return fs.lstat(abs).then(
    () => false,
    (e) => isMissing(e)
  );
}

/** The stat of whatever a new handle on the path reaches, taken as `readFileAt` takes it; null when nothing can be. */
async function handleStamp(abs: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await fs.open(abs, OPEN_READ);
  } catch {
    return null;
  }
  try {
    return stampOf(await handle.stat({ bigint: true }));
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Nothing at the path: the file, or a folder above it, is not there. */
function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** What a file's stat says about its bytes: any write to it, or a new file in its place, changes this. */
function stampOf(st: BigIntStats): string {
  return `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
}

/**
 * Whether a file's stat, taken at `now` (ms), can stand for its bytes later. It must have been last changed more
 * than `settleMs` before, so a later change cannot share its timestamps. A change time that only repeats a
 * whole-second modification time (SSHFS, FAT) is no change time at all: an edit that puts the old modification time
 * back would go unseen, so such files are always read.
 */
export function statTrusted(st: Pick<BigIntStats, 'mtimeNs' | 'ctimeNs'>, now: number, settleMs: number): boolean {
  if (st.mtimeNs === st.ctimeNs && st.mtimeNs % 1_000_000_000n === 0n) return false;
  const settled = (ns: bigint) => now - Number(ns / 1_000_000n) > settleMs;
  return settled(st.mtimeNs) && settled(st.ctimeNs);
}
const HISTORY_LIMIT = 100;
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
const IMPORTED_ASSET_RE = /^[a-z0-9][a-z0-9-]*-[a-f0-9]{8}(-\d+w)?\.(jpg|png|webp|gif|avif|svg|woff2?)$/;
/** Documents the importer named: never swept (see above), and never searched for the names of other files. */
const IMPORTED_DOCUMENT_RE = new RegExp(`^[a-z0-9][a-z0-9-]*-[a-f0-9]{8}\\.(${DOCUMENT_EXTENSIONS.join('|')})$`);
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

/** The name of the version saved before restoring the one named `name`, kept short however often restores nest. */
function backupName(name: string): string {
  const short = name.length > 50 ? `${name.slice(0, 49).trimEnd()}…` : name;
  return `Before restoring “${short}”`;
}

/** Every stored version a history entry restores or expects. */
const entryBlobs = (e: HistoryEntry) => Object.values(e.docs).flatMap((d) => [d.before, d.after]).filter((x): x is string => !!x);

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
const UNSETTLED = 'A save did not finish. Close and reopen the project to recover it.';
const LOCK_UNCHECKED = 'The project lock could not be checked, so nothing was changed. Try again.';

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
}

interface GeneratedManifest {
  generator: string;
  files: Record<string, string>;
  /** Files a publication was writing when it stopped: each is this app's own if it holds that version. */
  pending?: Record<string, string>;
}

/** Whether an operation changes a collection or one of its entries. */
const isCollectionOperation = (o: EditOperation) => o.type.startsWith('collection.') || o.type.startsWith('entry.');

/**
 * A collection change checked against files it does not write: a removal guards the links other entries and pages
 * hold, and a new address must be free of every page's and entry's. One changed outside the app since it was read
 * makes that check stale, so the change waits for it (see `wholeProject`).
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
    case 'collection.update':
      return o.route !== undefined;
    case 'entry.update':
      return o.slug !== undefined;
    default:
      return false;
  }
}

/** A page's document path, capturing the page ID. */
const PAGE_DOC = new RegExp(`^${DOC_DIR}/pages/([^/]+)\\.json$`);

/** How many recent copies a session keeps for Paste. */
const CLIPBOARD_LIMIT = 5;

export interface CommitOptions {
  label: string;
  source?: 'user' | 'ai' | 'system';
  /** Merge into the previous history entry when keys match and it was recent. */
  coalesceKey?: string;
  /** Skip history (used for provisional AI batches and undo/redo themselves). */
  history?: boolean;
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
}

/**
 * One open, writable project. Owns canonical state, the revision counter, history,
 * the publication journal and generated output. All writes pass through `apply` or `commitState`.
 */
export class ProjectSession extends EventEmitter {
  state!: ProjectState;
  revision = 0;
  private docs = new Map<string, string>();
  private history: HistoryFile = emptyHistory();
  private generated: GeneratedManifest = { generator: GENERATOR_VERSION, files: {} };
  /** Generated files kept between generations, each given back while what it was made from is unchanged. */
  private generation = new GenerationCache();
  /**
   * Generated files as last read from disk, by absolute path: the file's stat then and the hash of its bytes. A file
   * whose stat has not changed since is not read again.
   */
  private seenOnDisk = new Map<string, { stamp: string; hash: string }>();
  /** The hash of each generated file's latest content, by absolute path, so unchanged content is not hashed again. */
  private contentHashes = new Map<string, { content: string | Buffer; hash: string }>();
  /**
   * How long a file must have been left alone before its stat alone is trusted to show a later change: well past the
   * coarsest timestamps (two seconds on FAT), so a change in the same tick as the last one is never missed.
   */
  settleMs = 3000;
  /** Checks worked out from a state, kept for as long as it is the session's: the state is replaced, never changed. */
  private derived = new WeakMap<ProjectState, { diagnostics?: Diagnostic[]; saving?: Diagnostic[]; usages?: Record<string, number>; updates?: ThemeUpdates }>();
  conflicts: Conflict[] = [];
  /**
   * For each canonical document in conflict, the version SiteOrigin Builder holds (null = the document should not
   * exist). The in-memory state uses these versions; the external version stays on disk until the user chooses.
   */
  private pending = new Map<string, string | null>();
  /** Holds read back from conflicts.json when the project opened. */
  private loadedHolds = new Set<string>();
  recoveryNotes: string[] = [];
  /** Copies of the versions the author chose against when settling conflicts, newest first (see SavedCopy). */
  savedCopies: SavedCopy[] = [];
  /** Set when the project is open for inspection only: nothing is ever written. */
  readOnly: ReadOnlyInfo | null = null;
  /** History retention: the oldest groups are pruned past this many bytes of history blobs (spec 18.4). */
  historyByteLimit = 512 * 1024 * 1024;
  private gcCountdown = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  /** Run currently holding the writer lock. */
  activeRun: { id: string; before: Map<string, string>; beforeState: ProjectState; startRevision: number; written: Map<string, Set<string | null>> } | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  private idempotency = new Map<string, { fingerprint: string; result: ApplyResult }>();
  /** The documents were read in an older format and the update has not been stored yet. */
  private migrationDue = false;
  /** Publishing an update failed and may have left its journal, which only reopening the project can finish. */
  private migrationFailed = false;
  /** What the editor copied most recently, newest last. Held only while this project is open; never saved. A
   *  few are kept so a paste pressed before a later copy finished still finds the copy it followed. */
  private clipboards: Clipboard[] = [];
  /** A save failed after its journal was written: only reopening the project can finish it, so nothing else is written. */
  private unsettled = false;
  /** Named versions of the site, kept apart from history until the author deletes them (issue 260). */
  private versions: VersionStore;

  constructor(public readonly dir: string) {
    super();
    this.versions = new VersionStore(this.local('versions'));
  }

  local(...parts: string[]): string {
    return join(this.dir, LOCAL_DIR, ...parts);
  }

  // -------------------------------------------------------------------------
  // Open / create
  // -------------------------------------------------------------------------

  static async create(dir: string, state: ProjectState): Promise<ProjectSession> {
    const s = new ProjectSession(dir);
    s.state = state;
    await s.ensureLocalDirs();
    await s.writeAllDocs();
    await s.publishGenerated(true);
    await s.saveLocalState();
    return s;
  }

  static async open(dir: string, instanceId: string, opts: { force?: boolean | string } = {}): Promise<ProjectSession> {
    const s = new ProjectSession(dir);
    // A project from a newer version is never written to, not even its local folders.
    await assertKnownFormat(dir);
    // The lock comes first: recovery must never touch a project another window is editing, and a project
    // that turns out to be locked is opened read-only with nothing written.
    await ensureDir(s.local());
    const lockErr = await s.acquireLock(instanceId, opts.force);
    if (lockErr) throw lockErr;
    try {
      // Recovery writes too, so it runs fenced like any command.
      await s.serialize(async () => {
        if (!(await s.stillOwner())) {
          const now = await readLock(s.local('lock.json')).catch(() => null);
          throw new ProjectLockedError('The project was taken over while it was opening. Try again.', now ? judgeLock(s.local('lock.json'), now, instanceId, false).owner : { host: 'another computer', token: NO_LOCK });
        }
        await s.ensureLocalDirs();
        await s.openLocked();
      });
    } catch (e) {
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
    s.state = await readState(dir, { allowNewer: true });
    s.docs = stateToDocs(s.state);
    s.history = usableHistory(await readIfExists(s.local('history', 'history.json')).then((t) => (t ? (JSON.parse(t) as HistoryFile) : null)).catch(() => null));
    await s.versions.load().catch(() => undefined);
    await s.loadSavedCopies();
    const local = await readIfExists(s.local('state.json'));
    if (local) s.revision = JSON.parse(local).revision ?? 0;
    return s;
  }

  private async openLocked() {
    const s = this;
    const dir = this.dir;
    await s.loadSavedCopies();
    await s.loadConflicts();
    // Both recoveries run before the documents are first read: a file a crash left broken may be one they restore.
    await s.recoverJournal();
    await s.recoverInterruptedRun();
    const read = await readProject(dir, { overlay: s.pending });
    s.state = read.state;
    s.migrationDue = !!read.migration;
    s.docs = stateToDocs(s.state);
    s.history = usableHistory(await readIfExists(s.local('history', 'history.json')).then((t) => (t ? (JSON.parse(t) as HistoryFile) : null)));
    // Before the first sweep, which collects what no saved version names.
    await s.versions.load();
    const interrupted = await s.versions.takeRestoring().catch(() => null);
    if (interrupted) s.recoveryNotes.push(`Restoring “${interrupted.version}” was interrupted, so some of it may be missing. Your work from before is saved as “${interrupted.backup}” in History, under Saved versions.`);
    s.generated = (await readIfExists(join(dir, 'siteorigin', 'generated-manifest.json')).then((t) => (t ? JSON.parse(t) : null))) ?? s.generated;
    const local = await readIfExists(s.local('state.json'));
    if (local) s.revision = JSON.parse(local).revision ?? 0;
    // Validate the final state (after any rollback) before generating anything from it.
    const fatal = validateState(s.state).filter((d) => d.severity === 'error' && FATAL_CODES.has(d.code));
    if (fatal.length) throw new ProjectFormatError(`This project's documents are inconsistent, so it was not opened to protect your site: ${fatal.slice(0, 4).map((d) => d.message).join(' ')}`);
    // Generating from another copy of the site's theme would restyle it before anyone edited anything.
    const pin = themePinProblem(s.state);
    if (pin) throw new ThemeUnavailableError(pin);
    // With a file in conflict the update waits: its stored version is the user's to choose first.
    if (s.migrationDue && !s.pending.size) await s.publishMigration();
    else await s.publishGenerated(false);
    await s.sweep();
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
    for (const d of [this.dir, this.local(), this.local('history'), this.local('history', 'blobs'), this.local('sessions')]) await syncDir(d);
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
      const claim = this.lockState === 'held' ? await claimLock(this.local('lock.json'), this.lockToken!, { holder: this.lockToken!, waitMs: 1000 }) : null;
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

  /** Hold Builder's version of a document whose file was changed outside the app, replacing any earlier hold. */
  private holdConflict(path: string, builder: string | null, reason: string) {
    this.pending.set(path, builder);
    this.conflicts = this.conflicts.filter((c) => c.path !== path);
    this.conflicts.push({ path, reason, kind: 'canonical', ...(builder === null ? { builderMissing: true } : {}) });
  }

  private releaseConflict(path: string) {
    this.pending.delete(path);
    this.conflicts = this.conflicts.filter((c) => c.path !== path);
  }

  /** Canonical conflicts outlive a restart, so a reopened project never silently takes the external version. */
  private async saveConflicts() {
    const file = this.local('conflicts.json');
    if (!this.pending.size) return void (await fs.rm(file, { force: true }));
    const list = [];
    for (const [path, builder] of this.pending) {
      const reason = this.conflicts.find((c) => c.path === path)?.reason ?? 'Changed outside SiteOrigin Builder.';
      list.push({ path, reason, builder: builder === null ? null : await this.putBlob(builder) });
    }
    await atomicWrite(file, toJson({ conflicts: list }));
  }

  private async loadConflicts() {
    const text = await readIfExists(this.local('conflicts.json'));
    if (!text) return;
    let list: Array<{ path: string; reason: string; builder: string | null }> = [];
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
      // Already settled outside the app (the file was put back): nothing to choose.
      if (settledOnDisk(c.path, await this.diskContent(c.path), builder)) {
        settled = true;
        continue;
      }
      this.holdConflict(c.path, builder, String(c.reason ?? 'Changed outside SiteOrigin Builder.'));
      this.loadedHolds.add(c.path);
    }
    // Forgotten on disk too, or a later change to that file would bring the old choice back.
    if (settled) await this.saveConflicts();
  }

  /**
   * Settle one conflict. "restore" puts Builder's version back (the external file is copied to the recovery
   * folder first); "keep" accepts the external file, but only when the project is still valid with it.
   */
  resolveConflict(path: string, choice: 'keep' | 'restore'): Promise<{ ok: boolean; message?: string }> {
    return this.serialize(async () => {
      if (!(await this.stillOwner())) return { ok: false, message: this.readOnly?.reason ?? LOCK_UNCHECKED };
      if (this.activeRun) return { ok: false, message: 'Stop the AI before resolving conflicts.' };
      if (this.migrationFailed) return { ok: false, message: 'This project could not be updated to the current format. Close and reopen it.' };
      if (this.unsettled) return { ok: false, message: UNSETTLED };
      const conflict = this.conflicts.find((c) => c.path === path);
      if (!conflict) return { ok: true };
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
        } else await atomicWrite(abs, builder, { beforeReplace: unchanged });
        this.releaseConflict(path);
      } else {
        const overlay = new Map(this.pending);
        overlay.delete(path);
        let next: ProjectState;
        let migrated: boolean;
        try {
          const read = await readProject(this.dir, { overlay });
          next = read.state;
          migrated = !!read.migration;
        } catch (e) {
          return { ok: false, message: `The external version of ${path} could not be read, so it was not kept: ${(e as Error).message}` };
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
        if (builder !== null) await this.saveCopy(path, 'canonical', 'builder', builder);
        const nextDocs = stateToDocs(next);
        changed = await this.diffDocs(this.docs, nextDocs);
        this.state = next;
        this.docs = nextDocs;
        this.migrationDue ||= migrated;
        this.releaseConflict(path);
      }
      await this.saveConflicts();
      if (this.migrationDue && !this.pending.size) await this.publishMigration();
      const changedFiles = await this.publishGenerated(false);
      this.revision++;
      if (Object.keys(changed).length) await this.recordHistory(changed, { label: 'Keep external change', source: 'system' });
      await this.saveLocalState();
      this.emit('changed', { revision: this.revision, changedDocs: Object.keys(changed), changedFiles, label: 'Resolve conflict', source: 'user' } satisfies SessionEvent);
      return { ok: true };
    });
  }

  // -------------------------------------------------------------------------
  // Comparing conflict versions, and saved copies
  // -------------------------------------------------------------------------

  /** Both versions of a file in conflict, as text to compare: SiteOrigin Builder's, and the one on disk now. */
  async compareConflict(path: string): Promise<{ ok: boolean; builder?: FileText; disk?: FileText; message?: string }> {
    const conflict = this.conflicts.find((c) => c.path === path);
    if (!conflict) return { ok: false, message: 'That file is no longer in conflict.' };
    let builder: string | Buffer | null | undefined;
    try {
      builder = conflict.kind === 'canonical' ? (this.pending.get(path) ?? null) : await this.generatedContent(path);
    } catch {
      builder = undefined;
    }
    const disk = await readText(safeJoin(this.dir, path));
    return { ok: true, builder: builder === undefined ? { state: 'unreadable' } : builder === null ? { state: 'missing' } : textOf(builder), disk };
  }

  /** What a saved copy holds. Only a copy on the list is read, and only as the plain file it was saved as. */
  async readSavedCopy(id: string): Promise<{ ok: boolean; content?: FileText; message?: string }> {
    const copy = this.savedCopies.find((c) => c.id === id);
    if (!copy) return { ok: false, message: 'That saved copy is no longer listed.' };
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
      this.savedCopies = this.savedCopies.filter((c) => c.id !== id);
      return { ok: true };
    });
  }

  /**
   * Keep one version of a file in conflict before the other replaces it, and list it under Saved copies so it can be
   * found again, also after the project is reopened. The copy is listed before anything is replaced: a crash between
   * the two leaves it in the recovery folder, never lost.
   */
  private async saveCopy(path: string, kind: Conflict['kind'], side: SavedCopy['side'], bytes: string | Buffer) {
    const id = randomBytes(8).toString('hex');
    const savedAt = Date.now();
    // Named for its file, side and time, and made unique by its ID, so it never replaces an earlier copy. The file's
    // own name is cut short: the list says where it came from in full, and a deep route must not make a name too
    // long to save.
    const name = `${savedAt}-${id}-${path.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)}.${side}`;
    // Only ever inside this project: a recovery folder that is a link elsewhere is not written through.
    const file = `${LOCAL_DIR}/recovery/${name}`;
    const list = safeJoin(this.dir, `${LOCAL_DIR}/recovery/${SAVED_COPIES}`);
    await atomicWrite(safeJoin(this.dir, file), bytes);
    // Read again first: the list on disk is the one to add to, entries whose copy is away for now included.
    const listed = await this.loadSavedCopies({ forWrite: true });
    const copy = { id, path, kind, side, savedAt, file };
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
      const entry = { id: c.id, path: c.path, kind: c.kind, side: c.side, savedAt: c.savedAt, file: c.file };
      all.push(entry);
      // One entry that cannot be checked (it leads outside the project) is left out; the rest still are shown.
      const plain = await (async () => (await fs.lstat(safeJoin(this.dir, c.file))).isFile())().catch(() => false);
      if (plain) shown.push(entry);
    }
    this.savedCopies = shown.sort((a, b) => b.savedAt - a.savedAt);
    return all;
  }

  /** What SiteOrigin Builder generates for a file now: the clean source, or a theme file copied from its pack. */
  private async generatedContent(path: string): Promise<string | Buffer | undefined> {
    const clean = this.generate(this.state, false);
    const copy = packFileCopies(this.state).find((c) => c.path === path);
    return clean.get(path) ?? (copy ? await readPackFile(copy.pack, copy.file) : undefined);
  }

  /**
   * A change stopped because a file was saved outside the app: refused cleanly, to be tried again once the file is
   * read, unless part of the change was already on disk, which only reopening the project can finish.
   */
  private diskConflict(e: DiskConflictError): NonNullable<ApplyResult['error']> {
    return this.unsettled ? { code: 'CONFLICT', message: UNSETTLED, recoverable: false } : { code: 'CONFLICT', message: e.message, recoverable: true };
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

  /** Roll forward an interrupted publication: every intended write is stored as a blob before any file is replaced. */
  private async recoverJournal() {
    const j = await readIfExists(this.local('journal.json'));
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
      if (h !== w.before) {
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
      if (sha(disk) !== d.before) {
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
        this.releaseConflict(path);
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
        if (before !== undefined) this.holdConflict(path, before, 'Changed outside SiteOrigin Builder during an interrupted AI run.');
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
    for (const [path, content] of this.docs) await atomicWrite(safeJoin(this.dir, path), content);
  }

  /**
   * Persist a new canonical state, regenerate derived files and record history. `cursor` moves the undo position
   * instead of recording a new step (undo and redo).
   */
  private async persist(next: ProjectState, opts: CommitOptions & { runId?: string; cursor?: number; wholeProject?: boolean }): Promise<SessionEvent> {
    // A state whose theme is not available here would be generated from the wrong pack.
    const pin = themePinProblem(next);
    if (pin) throw new Error(pin);
    // Generate first: a generator failure must not leave canonical documents half-published.
    const generated = { clean: this.generate(next, false), dev: this.generate(next, true) };
    const nextDocs = stateToDocs(next);
    const changed: Record<string, { before: string | null; after: string | null }> = {};
    const writes: Array<{ path: string; blob: string; content: string; before: string | null }> = [];
    const deletes: Array<{ path: string; before: string }> = [];
    for (const [path, content] of nextDocs) {
      const prev = this.docs.get(path);
      if (prev === content) continue;
      changed[path] = { before: prev === undefined ? null : await this.putBlob(prev), after: await this.putBlob(content) };
      writes.push({ path, blob: changed[path].after!, content, before: changed[path].before });
    }
    for (const [path, prev] of this.docs) {
      if (nextDocs.has(path)) continue;
      changed[path] = { before: await this.putBlob(prev), after: null };
      deletes.push({ path, before: changed[path].before! });
    }
    // Authored sources go before the definitions that name them, so a component's definition is never missing
    // beside its source part way through a delete: recovery can then tell that from a definition deleted outside.
    // Entries go before their collection's settings for the same reason: an entry is never left without the collection
    // it belongs to, which reading the project would refuse.
    const deleteRank = (p: string) => (CUSTOM_SOURCE_RE.test(p) ? 0 : collectionPathOf(p)?.entryId !== undefined ? 1 : 2);
    deletes.sort((a, b) => deleteRank(a.path) - deleteRank(b.path));
    // A change worked out from the whole project (a theme update or switch, a format update) also depends on files it
    // does not write: what builds on a component, what its placements hold. One changed outside the app since it was
    // read (an edit the watcher has not delivered yet) makes those checks stale, so the change waits for it. The
    // manifest says nothing they read, and the watcher does not see it change. The files it writes are checked after
    // this, last, so an edit to one of them while this reads is still caught.
    if (opts.wholeProject) {
      const unloaded = await this.unloadedEdit(new Set([...Object.keys(changed), MANIFEST]));
      if (unloaded) throw new DiskConflictError(unloaded);
    }
    // Never overwrite a newer version on disk (for example an edit the file watcher has not delivered yet). A file
    // that already holds exactly what this change leaves there (a source kept when its definition was deleted
    // outside the app, say) is not overwritten by it.
    const unchangedOnDisk = async (path: string) => {
      const disk = await this.diskContent(path);
      const target = nextDocs.get(path);
      const already = !this.activeRun && target !== undefined && disk !== null && sameContent(path, disk, target);
      if (!sameContent(path, disk, this.docs.get(path) ?? null) && !already) throw new DiskConflictError(path);
      return true;
    };
    for (const path of Object.keys(changed)) await unchangedOnDisk(path);
    if (this.activeRun) await this.writeRunMarker(nextDocs);
    // The undo position is part of the change: planned now, journaled with the documents, installed with them.
    const planned =
      opts.history !== false && Object.keys(changed).length
        ? this.planHistory(changed, opts, this.revision + 1)
        : opts.cursor !== undefined
          ? { history: { ...this.history, cursor: opts.cursor }, pruned: false, entryId: undefined }
          : null;
    const journaled = !!(writes.length || deletes.length || planned);
    let changedFiles: string[];
    // Files replaced or removed so far: a change stopped before the first one has changed nothing on disk.
    let installed = 0;
    try {
      // Journal first, then replace files.
      if (journaled) await this.writeJournal({ writes: writes.map(({ path, blob, before }) => ({ path, blob, before })), deletes, history: planned?.history, revision: this.revision + 1 });
      // Each file is checked again just before it is replaced or removed: one saved outside the app since the check
      // above (while the journal was being written) is never replaced unseen.
      for (const w of writes) {
        await atomicWrite(safeJoin(this.dir, w.path), w.content, { beforeReplace: () => unchangedOnDisk(w.path) });
        installed++;
      }
      for (const d of deletes) {
        await unchangedOnDisk(d.path);
        await this.removeCanonical(d.path);
        installed++;
      }
      this.state = next;
      this.docs = nextDocs;
      changedFiles = await this.publishGenerated(false, generated);
      if (planned) await this.installHistory(planned.history);
      this.revision++;
      await this.saveLocalState();
      if (journaled) await removeDurable(this.local('journal.json'));
    } catch (e) {
      // Stopped by a file saved outside the app before anything was replaced: nothing of this change is on disk, so
      // its journal goes and the project carries on (an AI request's own recovery marker is left to its rollback).
      if (journaled && installed === 0 && !this.activeRun && e instanceof DiskConflictError) {
        const cleared = await removeDurable(this.local('journal.json')).then(
          () => true,
          () => false
        );
        if (cleared) throw e;
      }
      // The journal on disk may now describe this change; a later save would replace it. Reopening finishes it.
      if (journaled) this.unsettled = true;
      throw e;
    }
    if (planned && (planned.pruned || --this.gcCountdown <= 0)) await this.sweep();
    const event: SessionEvent = { revision: this.revision, changedDocs: Object.keys(changed), changedFiles, label: opts.label, source: opts.source ?? 'user', entryId: planned?.entryId };
    this.emit('changed', event);
    return event;
  }

  private async writeJournal(j: Omit<Journal, 'schemaVersion'>) {
    await atomicWrite(this.local('journal.json'), toJson({ schemaVersion: SCHEMA_VERSION, ...j } satisfies Journal));
  }

  /** Every generated file for `state`, reusing what earlier generations made from inputs that are unchanged. */
  private generate(state: ProjectState, instrument: boolean): Map<string, string> {
    return generateProject(state, { instrument }, this.generation);
  }

  /**
   * The hash a generated file's bytes had when last read, while its stat is still what it was then: looking costs a
   * stat, never a read. Undefined when the file has to be read to be known.
   */
  private async seenHash(abs: string): Promise<string | undefined> {
    const seen = this.seenOnDisk.get(abs);
    if (!seen) return undefined;
    const st = await fs.stat(abs, { bigint: true }).catch(() => null);
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
  private async readHash(abs: string): Promise<{ hash: string | null; stamp: string | null }> {
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
      const stamp = stampOf(before);
      if (statTrusted(before, started, this.settleMs)) this.seenOnDisk.set(abs, { stamp, hash });
      return { hash, stamp };
    }
    // Changing under every read: someone else is writing it.
    return { hash: UNREADABLE, stamp: null };
  }

  /** Regenerate derived files. Files edited externally since the last generation are preserved and reported. */
  private async publishGenerated(initial: boolean, pre?: { clean: Map<string, string>; dev: Map<string, string> }): Promise<string[]> {
    const clean = new Map(pre?.clean ?? this.generate(this.state, false));
    const dev = new Map(pre?.dev ?? this.generate(this.state, true));
    const devRoot = this.local('cache', 'dev');
    const changedFiles: string[] = [];
    const prev = this.generated.files;
    const inflight = this.generated.pending ?? {};
    const known = (path: string) => !!prev[path] || !!inflight[path];
    // SvelteKit runs one server hook: a project with its own keeps it, and the generated one is left out (the
    // not-found page then keeps the addresses it was built with, and the export says so or, for a site with pages in
    // another language, stops).
    if (ownServerHook(this.dir, known(SERVER_HOOK_FILE))) for (const files of [clean, dev]) files.delete(SERVER_HOOK_FILE);
    const ours = (path: string, hash: string | null) => hash !== null && (hash === prev[path] || hash === inflight[path]);
    const nextFiles: Record<string, string> = {};
    const authored = new Set(stateToAuthoredSources(this.state).keys());
    const hashes = new Map<string, { content: string | Buffer; hash: string }>();
    const hashOf = (abs: string, content: string | Buffer) => {
      const was = this.contentHashes.get(abs);
      const hash = was && was.content === content ? was.hash : sha(content);
      hashes.set(abs, { content, hash });
      return hash;
    };
    this.conflicts = this.conflicts.filter((c) => c.kind !== 'generated');
    // The theme's font files are copied from its pack beside the generated text, under the same ownership rules.
    const copies = new Map<string, string | Buffer>();
    for (const c of packFileCopies(this.state)) {
      if (authored.has(c.path) || clean.has(c.path)) continue;
      try {
        copies.set(c.path, await readPackFile(c.pack, c.file));
      } catch (e) {
        // A damaged or missing pack file costs that font's update, not the save: a copy already in the project stays,
        // still claimed, so it is neither replaced nor removed as obsolete.
        console.warn(`Not copying ${c.path}: ${(e as Error).message}`);
        // Only a copy that already is the pack's validated file is kept: another theme's file of the same name is not.
        // A copy that cannot be read stays claimed, so it is never removed and a missing one is still noticed.
        if (!known(c.path)) continue;
        const disk = await readBytesIfExists(safeJoin(this.dir, c.path));
        const h = disk === null ? null : sha(disk);
        if (h === null) nextFiles[c.path] = prev[c.path] ?? inflight[c.path];
        else if (ours(c.path, h) && h === packFileInfo(c.pack, c.file)?.sha256) nextFiles[c.path] = h;
      }
    }
    // Looked at together, a stat each: a file unchanged on disk since it was last read is not read again.
    const project = [...copies, ...clean].filter(([path]) => !authored.has(path)).map(([path, content]) => ({ path, content, abs: safeJoin(this.dir, path) }));
    const seen = await inBatches(project, (f) => this.seenHash(f.abs));
    // Decide first which project files are someone else's now, so no editor variant shadows them in the preview.
    const plan: Array<{ path: string; content: string | Buffer; abs: string; hash: string; stamp: string | null }> = [];
    const desired: Record<string, string> = {};
    for (const [i, { path, content, abs }] of project.entries()) {
      const was = this.contentHashes.get(abs)?.hash;
      const h = hashOf(abs, content);
      desired[path] = h;
      nextFiles[path] = h;
      // Generated the same as last time, and still the bytes it was then: nothing to decide.
      if (seen[i] === h && was === h) continue;
      // To be replaced, kept as someone else's, or found already right: decided on its bytes as they are now, read
      // one file at a time so each decision is as close to the write as the old full pass made it.
      const { hash: diskHash, stamp } = await this.readHash(abs);
      if (diskHash === h) continue;
      if (!initial && diskHash !== null && known(path) && !ours(path, diskHash)) {
        // Edited outside the app (or no longer readable by it): keep the external version.
        nextFiles[path] = prev[path] ?? inflight[path];
        this.conflicts.push({ path, reason: diskHash === UNREADABLE ? UNREADABLE_REASON : 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.', kind: 'generated' });
        continue;
      }
      if (!initial && diskHash !== null && !known(path)) {
        // A file we never wrote already lives here: never overwrite someone's own work.
        delete nextFiles[path];
        this.conflicts.push({ path, reason: 'Generated file would replace a file that SiteOrigin Builder did not create. Move or delete that file, then restore.', kind: 'generated' });
        continue;
      }
      plan.push({ path, content, abs, hash: h, stamp });
    }
    const keptExternal = new Set(this.conflicts.filter((c) => c.kind === 'generated').map((c) => c.path));
    // Dev variants (with editor identity attributes, never part of the portable source) are written before the
    // project files, so the dev server never loads a stale instrumented file. A file kept as edited outside the
    // app has no variant: the preview shows the external version, as the exported site would.
    const variants = [...dev].filter(([path]) => !authored.has(path)).map(([path, content]) => ({ path, content, abs: safeJoin(devRoot, path) }));
    // A variant that cannot be read is written again: only the app writes them.
    const variantsOnDisk = await inBatches(variants, async (f) => (keptExternal.has(f.path) ? null : ((await this.seenHash(f.abs)) ?? (await this.readHash(f.abs)).hash)));
    for (const [i, { path, content, abs }] of variants.entries()) {
      if (keptExternal.has(path)) {
        if (existsSync(abs)) {
          await fs.rm(abs, { force: true });
          this.seenOnDisk.delete(abs);
          // The preview may have cached the variant; touching the real file makes it load that file instead.
          const now = new Date();
          await fs.utimes(safeJoin(this.dir, path), now, now).catch(() => undefined);
        }
        continue;
      }
      // Rebuilt from the documents on every publication, so a power loss costs nothing here.
      const hash = hashOf(abs, content);
      if (variantsOnDisk[i] !== hash) {
        this.seenOnDisk.delete(abs);
        await atomicWrite(abs, content, { durable: false });
        // Only the app writes its preview variants, so the file now on disk is this one.
        const st = await fs.stat(abs, { bigint: true }).catch(() => null);
        if (st) this.seenOnDisk.set(abs, { stamp: stampOf(st), hash });
      }
    }
    // The preview serves a variant only while the project file is the one generated here; written before the
    // project files, so a file mid-publication is never mistaken for an edit made outside the app.
    await atomicWrite(join(devRoot, CLEAN_HASHES), JSON.stringify(desired), { durable: false });
    // Claimed before they are written: a publication that stops part way (a crash, an AI run being rolled back)
    // leaves files the next one recognises as its own, to replace or remove, never as someone else's.
    if (plan.length) await this.writeManifest(prev, { ...inflight, ...Object.fromEntries(plan.map((f) => [f.path, f.hash])) });
    for (const { path, content, abs, hash: h, stamp } of plan) {
      this.seenOnDisk.delete(abs);
      let theirs = false;
      // Checked again once the new file is ready, just before it takes the path: a file that changed since it was
      // looked at (saved by an editor meanwhile, say) is decided again on what is there now.
      const replace = async () => {
        if (initial) return true;
        const now = await lookAt(abs);
        if ((now === 'missing' ? null : now === 'failed' ? UNREADABLE : stampOf(now)) === stamp) return true;
        const { hash: there } = await this.readHash(abs);
        if (there === h) return false;
        // Nothing readable there may still be something: a link to nowhere is someone else's too.
        if (there === null && !(await fs.lstat(abs).catch(() => null))) return true;
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
      if (written) changedFiles.push(path);
      else if (theirs) {
        if (known(path)) nextFiles[path] = prev[path] ?? inflight[path];
        else delete nextFiles[path];
        this.conflicts.push({ path, reason: 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.', kind: 'generated' });
        const variant = safeJoin(devRoot, path);
        await fs.rm(variant, { force: true });
        this.seenOnDisk.delete(variant);
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
        await removeEmptyDirs(dirname(abs), join(this.dir, 'src'));
        changedFiles.push(path);
      }
    }
    await this.writeManifest(nextFiles);
    this.contentHashes = hashes;
    // Only files still generated are worth remembering.
    for (const abs of this.seenOnDisk.keys()) if (!hashes.has(abs)) this.seenOnDisk.delete(abs);
    return changedFiles;
  }

  private async writeManifest(files: Record<string, string>, pending?: Record<string, string>) {
    this.generated = { generator: GENERATOR_VERSION, files, ...(pending ? { pending } : {}) };
    const sorted = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).sort());
    await atomicWrite(
      join(this.dir, 'siteorigin', 'generated-manifest.json'),
      toJson({ generator: GENERATOR_VERSION, note: 'Hashes of files generated by SiteOrigin Builder.', files: sorted(files), ...(pending ? { pending: sorted(pending) } : {}) })
    );
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
    if (this.unsettled) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: UNSETTLED, recoverable: false } };
    return null;
  }

  private async restoreGeneratedLocked(path: string) {
    const content = await this.generatedContent(path);
    if (content === undefined) throw new Error('That file is no longer generated.');
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
    await atomicWrite(abs, content, { beforeReplace: unchanged });
    this.generated.files[path] = sha(content);
    this.conflicts = this.conflicts.filter((c) => c.path !== path);
    await this.publishGenerated(false);
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
   */
  apply(batch: EditBatch, opts: CommitOptions & { runId?: string; idempotencyKey?: string; codeAllowed?: boolean; componentImport?: ComponentImport }): Promise<ApplyResult> {
    return this.serialize(async () => {
      const fingerprint = sha(JSON.stringify(batch.operations));
      if (opts.idempotencyKey && this.idempotency.has(opts.idempotencyKey)) {
        const prior = this.idempotency.get(opts.idempotencyKey)!;
        if (prior.fingerprint === fingerprint) return prior.result;
        return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'That tool call ID was already used for a different request.', recoverable: true } };
      }
      if (opts.runId && this.activeRun?.id !== opts.runId)
        return { ok: false, revision: this.revision, error: { code: 'CANCELLED', message: 'That AI request is no longer running.', recoverable: false } };
      if (this.activeRun && opts.runId !== this.activeRun.id)
        return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'The AI is making changes. Stop it before editing.', recoverable: true } };
      if (batch.expectedRevision !== undefined && batch.expectedRevision !== this.revision)
        return { ok: false, revision: this.revision, error: { code: 'STALE_REVISION', message: `Expected revision ${batch.expectedRevision} but the project is at ${this.revision}. Read the latest state and try again.`, recoverable: true } };
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      const ops = [];
      for (const raw of batch.operations) {
        const v = validateOperation(raw);
        if (!v.ok) return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: v.message, recoverable: true } };
        ops.push(v.op);
      }
      // Checked here, in turn with every other edit and with the editor's clipboard, so what it copies is what lands.
      const importing = ops.some((o) => o.type === 'component.import');
      // A package is read and checked by the editor's import, which is the only way one reaches a project.
      if (importing && (opts.source === 'ai' || opts.runId))
        return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: 'Only the editor can import a component package. Ask the user to import it from the component library.', recoverable: true } };
      const context = { clipboards: this.clipboards, ...(opts.componentImport ? { componentImport: opts.componentImport } : {}) };
      const code = opts.codeAllowed === false ? developerModeRefusal(this.state, ops, context) : null;
      if (code) return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: `${code} Turn on Developer mode in Settings to work with code.`, recoverable: true } };
      // Paste places what the editor copied; an AI run never sends it.
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'node.paste'))
        return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'node.paste is only for the editor. Use node.copy.', recoverable: true } };
      // Collections have no tools of their own yet: the assistant neither sees nor changes them.
      if ((opts.source === 'ai' || opts.runId) && ops.some(isCollectionOperation))
        return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: 'Collections and their entries can only be changed in the editor for now.', recoverable: true } };
      // A library image's file is only ever one the importer checked and wrote.
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'asset.relink'))
        return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: 'Only the editor can give an image a new file. Ask the user to locate it in Assets.', recoverable: true } };
      // Removing a file of a font the site uses changes how its text is drawn: the author decides, having seen what changes.
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'asset.remove' && o.fontUses !== undefined))
        return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: 'Only the editor can remove a file of a font the site uses. Change the styles that use the font first, or ask the user to remove the file in Assets, where they see what changes.', recoverable: true } };
      let next: ProjectState;
      let results;
      try {
        ({ state: next, results } = applyOperations(this.state, ops, context));
      } catch (e) {
        if (e instanceof EngineError) return { ok: false, revision: this.revision, error: { code: e.code, message: e.message, recoverable: true, details: e.details } };
        return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: (e as Error).message, recoverable: true } };
      }
      const pin = themePinProblem(next);
      if (pin) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: pin, recoverable: false } };
      // Any authored code that is new or changed must pass the safety checks before it can be saved. Imports
      // are followed into the components as they will be once this batch is saved, whichever order it made them in.
      const resolve = componentSources(next.components);
      // A package's code was written by someone else, for another project: it is held to the assistant's policy, and
      // may import the designs it came with as the app generates them here.
      const designs = importing ? new Set(Object.values(next.components).filter((d) => d.kind === 'managed').map(defFile)) : null;
      for (const def of Object.values(next.components)) {
        if (def.kind !== 'code' || def.source === undefined || this.state.components[def.id]?.source === def.source) continue;
        // Placing a theme's own component (the contact form, say) authors no code when it is code the app ships,
        // whichever pack reuses it.
        if (def.owner === 'theme' && listThemes().some((t) => t.source !== 'user' && t.components.some((c) => c.kind === 'code' && c.source === def.source))) continue;
        // Code the AI writes is held to a stricter policy than code a developer writes, and so is an installed pack's
        // own code, which nobody here wrote or reviewed.
        const installed = def.owner === 'theme' && listThemes().some((t) => t.source === 'user' && t.components.some((c) => c.id === def.id));
        const errors = (
          await checkSvelteSource(def.source, {
            strict: opts.source === 'ai' || installed || importing,
            filename: def.sourcePath,
            resolve,
            ...(designs ? { author: 'Code in a component package', generated: (p: string) => designs.has(p) } : {})
          })
        ).filter((p) => p.severity === 'error');
        if (errors.length)
          return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: `The code for "${def.name}" has problems: ${errors.map((e) => (e.line ? `line ${e.line}: ` : '') + e.message).join(' ')}`, recoverable: true, details: errors } };
      }
      // An import is checked place by place: a problem in what it brings is new even if another component has the same.
      const introduced = importing ? this.introducedProblems(next) : introducedDiagnostics(this.savingProblems(this.state), this.savingProblems(next));
      if (introduced.length)
        return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: introduced.map((d) => d.message).join(' '), recoverable: true, details: introduced } };
      let ev: SessionEvent;
      try {
        ev = await this.persist(next, { ...opts, wholeProject: ops.some((o) => o.type === 'theme.refresh' || o.type === 'theme.apply' || readsWholeProject(o, this.state)) });
      } catch (e) {
        if (e instanceof DiskConflictError) return { ok: false, revision: this.revision, error: this.diskConflict(e) };
        throw e;
      }
      const result: ApplyResult = { ok: true, revision: this.revision, results, changed: ev.changedDocs, entryId: ev.entryId };
      if (opts.idempotencyKey) this.idempotency.set(opts.idempotencyKey, { fingerprint, result });
      return result;
    });
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

  /** Document problems. File conflicts are reported separately (`conflicts`), with their actions, never twice. */
  diagnostics(): Diagnostic[] {
    try {
      return this.memo(this.state, 'diagnostics', validateState);
    } catch (e) {
      // A project from a newer version may not follow this version's shapes; it is open read-only anyway.
      if (this.readOnly) return [];
      throw e;
    }
  }

  /** How many places use each library asset. */
  assetUsages(): Record<string, number> {
    return this.memo(this.state, 'usages', assetUsages);
  }

  /** Theme components with a newer version available. */
  themeUpdates(): ThemeUpdates {
    return this.memo(this.state, 'updates', themeUpdates);
  }

  /** Problems that stop a state from being saved. */
  private savingProblems(state: ProjectState): Diagnostic[] {
    return this.memo(state, 'saving', (st) => validateState(st, { sectionLinks: false }).filter(blocksSaving));
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
    return (checks[key] ??= compute(state));
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
  private planHistory(docs: HistoryEntry['docs'], opts: CommitOptions & { runId?: string }, revision: number): { history: HistoryFile; pruned: boolean; entryId: string } {
    const h = structuredClone(this.history);
    noteDropped(h, h.entries.slice(h.cursor), 'undone');
    h.entries = h.entries.slice(0, h.cursor);
    const last = h.entries[h.entries.length - 1];
    let id: string;
    if (opts.coalesceKey && last?.coalesceKey === opts.coalesceKey && Date.now() - Date.parse(last.time) < 4000) {
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
        runId: opts.runId
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
    if (planned.pruned || --this.gcCountdown <= 0) await this.sweep();
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
   * History retention (spec 18.4): keep at most 100 groups and 512 MiB of history blobs, pruning the oldest
   * groups first, then delete blobs nothing references and imported asset files that neither the project,
   * its retained history, an active run nor a held conflict can still need. Never fails a save.
   */
  collectGarbage(): Promise<void> {
    // Queued behind any save, so a blob is never swept between being written and being recorded.
    return this.serialize(() => this.sweep());
  }

  private async sweep(): Promise<void> {
    // A save waiting for reopening may need files only its journal names.
    if (this.unsettled || !(await this.stillOwner())) return;
    this.gcCountdown = 25;
    try {
      await this.collectGarbageNow();
    } catch {
      /* best effort: a failed sweep is retried next time */
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
      for (const text of [...(this.activeRun?.before.values() ?? []), ...this.pending.values()]) if (text) for (const t of tokens) if (text.includes(t)) pinned.add(t);
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
      versions: { count: this.versions.versions.length, bytes: this.versions.totalBytes() },
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
      entries: h.entries.map((e, i) => ({ id: e.id, label: e.label, source: e.source, time: e.time, applied: i < h.cursor, runId: e.runId })),
      ...(h.droppedRuns ? { droppedRuns: { ...h.droppedRuns } } : {})
    };
  }

  // -------------------------------------------------------------------------
  // Saved versions (issue 260)
  // -------------------------------------------------------------------------

  /** The saved versions, newest first, with what each one alone takes on disk. */
  versionsInfo(): VersionsInfo {
    const store = this.versions;
    return {
      list: [...store.versions].reverse().map((v) => ({
        id: v.id,
        name: v.name,
        time: v.time,
        auto: !!v.auto,
        pages: Object.keys(v.docs).filter((p) => PAGE_DOC.test(p)).length,
        bytes: store.exclusiveBytes(v),
        missing: Object.keys(v.media).filter((p) => v.media[p] === null)
      })),
      bytes: store.totalBytes(),
      ...(store.problem ? { problem: store.problem } : {})
    };
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
    const texts = [...docs.values()];
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
  private async captureVersion(name: string, opts: { auto?: boolean; also?: string[]; filled?: Record<string, string> } = {}): Promise<SavedVersion> {
    const docs: Record<string, string> = {};
    for (const [path, content] of this.docs) docs[path] = await this.versions.putText(content);
    const media: Record<string, string | null> = {};
    for (const rel of new Set([...(await this.versionMediaPaths(this.docs)), ...(opts.also ?? [])])) {
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
   * Save the site as it is now as a named version, kept until the author deletes it. A file its documents name that
   * is missing from the folder does not stop the save: it is listed in `missing`, and the version records it as such.
   */
  saveVersion(name: string): Promise<{ ok: boolean; message?: string; id?: string; missing?: string[] }> {
    return this.serialize(async () => {
      const why = await this.versionsBlocked();
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
        await this.versions.publish([...this.versions.versions, v]);
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
      this.emit('history');
      return { ok: true, id: v.id, missing: Object.keys(v.media).filter((p) => v.media[p] === null) };
    });
  }

  /**
   * What restoring `v` leaves: the project it holds, brought up to the current format if it is older, with this
   * project's own manifest (its identity stays, whichever version of the site it holds), and the files to put back.
   * Every object it needs is read and checked, and the project it leaves validated, before anything is written.
   */
  private async restorePlan(v: SavedVersion): Promise<{ ok: false; message: string } | { ok: true; state: ProjectState; docs: Map<string, string>; files: Array<{ path: string; hash: string; replaces: boolean }>; left: string[] }> {
    const refuse = (message: string) => ({ ok: false as const, message });
    if (v.schemaVersion > SCHEMA_VERSION) return refuse(`“${v.name}” was saved by a newer version of SiteOrigin Builder. Update the app to restore it.`);
    const stored = new Map<string, string>();
    try {
      for (const [path, h] of Object.entries(v.docs)) stored.set(path, (await this.versions.read(h)).toString('utf8'));
    } catch (e) {
      return refuse((e as Error).message);
    }
    let state: ProjectState;
    try {
      const read = await readProject(this.dir, { only: stored });
      state = { ...read.state, manifest: this.state.manifest };
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
      try {
        await this.versions.read(h);
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
    return { ok: true, state, docs: stateToDocs(state), files, left };
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
        site: false,
        styles: false,
        components: 0,
        library: false,
        files: [],
        replaced: [],
        left: [],
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
        } else if (p === `${DOC_DIR}/site.json`) review.site = true;
        else if (p === `${DOC_DIR}/tokens.json`) review.styles = true;
        else if (p === ASSETS_DOC) review.library = true;
      }
      const ids = new Set([...Object.keys(plan.state.components), ...Object.keys(this.state.components)]);
      review.components = [...ids].filter((c) => JSON.stringify(plan.state.components[c] ?? null) !== JSON.stringify(this.state.components[c] ?? null)).length;
      review.files = plan.files.map((f) => f.path);
      review.replaced = plan.files.filter((f) => f.replaces).map((f) => f.path);
      review.left = plan.left;
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
  restoreVersion(id: string, expectedRevision: number, reviewed?: { files: string[]; replaced: string[] }): Promise<RestoreVersionResult> {
    return this.serialize(async () => {
      const why = await this.versionsBlocked();
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
      const docsChange = plan.docs.size !== this.docs.size || [...plan.docs].some(([p, c]) => this.docs.get(p) !== c);
      if (!docsChange && !plan.files.length) return { ok: true, unchanged: true, revision: this.revision };
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
      try {
        const now = await this.captureVersion(backupName(v.name), { auto: true, also: replaced, filled });
        const kept = this.versions.versions.find((x) => sameContents(x, now));
        backup = kept ?? now;
        if (!kept) {
          if (!(await this.stillOwner())) return { ok: false, message: this.readOnly?.reason ?? LOCK_UNCHECKED };
          await this.versions.publish([...this.versions.versions, now]);
        }
      } catch (e) {
        return { ok: false, message: `Your current work could not be saved first, so nothing was restored. ${(e as Error).message}` };
      }
      const way = { id: backup.id, name: backup.name };
      this.emit('history');
      const label = `Restore “${v.name}”`;
      const written: Array<{ path: string; hash: string; prior: string | null }> = [];
      let ev: SessionEvent | null = null;
      const earlier = await this.versions.markRestoring(v.name, way.name);
      const clear = async () => {
        if (!earlier) await this.versions.clearRestoring().catch(() => undefined);
      };
      const docsBefore = this.docs;
      try {
        for (const f of plan.files) {
          const before = prior.get(f.path) ?? null;
          if (before === f.hash) continue;
          // A takeover by another app, or a change to the file since it was copied aside, stops the restore.
          if (!(await this.stillOwner())) throw new RestoreStopped(this.readOnly?.reason ?? LOCK_UNCHECKED);
          const abs = safeJoin(this.dir, f.path);
          // Read before the file is checked, so as little time as possible passes between the check and the write.
          const bytes = await this.versions.read(f.hash);
          const now = await fs.readFile(abs).then(sha, (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
          if (now !== before) throw new RestoreStopped(`${f.path} changed while the version was being restored, so nothing was restored.`);
          // Noted before writing: a write that lands but fails to report so is still undone.
          written.push({ path: f.path, hash: f.hash, prior: before });
          await atomicWrite(abs, bytes);
        }
        if (written.length) await this.refreshAssetFiles().catch(() => false);
        if (!(await this.stillOwner())) throw new RestoreStopped(this.readOnly?.reason ?? LOCK_UNCHECKED);
        if (docsChange) ev = await this.persist(plan.state, { label, source: 'user' });
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
      await clear();
      if (!ev) this.emit('changed', { revision: this.revision, changedDocs: [], changedFiles: written.map((w) => w.path), label, source: 'user' } satisfies SessionEvent);
      return { ok: true, revision: this.revision, entryId: ev?.entryId, backup: way, replaced: written.filter((w) => w.prior).length, left: plan.left };
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

  /** Delete saved version `id`, and what no other version holds. */
  deleteVersion(id: string): Promise<{ ok: boolean; message?: string; freed?: number }> {
    return this.serialize(async () => {
      const blocked = await this.writeBlocked();
      if (blocked) return { ok: false, message: blocked.error?.message };
      if (this.versions.problem) return { ok: false, message: this.versions.problem };
      const left = this.versions.versions.filter((v) => v.id !== id);
      if (left.length === this.versions.versions.length) return { ok: true, freed: 0 };
      try {
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
    return null;
  }

  /** Move history: restore the documents of an entry, refusing if those documents changed since. */
  private async travel(entry: HistoryEntry, direction: 'undo' | 'redo'): Promise<ApplyResult> {
    const expect = direction === 'undo' ? 'after' : 'before';
    const target = direction === 'undo' ? 'before' : 'after';
    for (const [path, d] of Object.entries(entry.docs)) {
      const cur = this.docs.get(path);
      const curHash = cur === undefined ? null : sha(cur);
      if (curHash !== d[expect])
        return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} "${entry.label}" because ${path} has changed since.`, recoverable: false } };
    }
    // Build the target state from documents.
    const docs = new Map(this.docs);
    for (const [path, d] of Object.entries(entry.docs)) {
      const h = d[target];
      if (h === null) docs.delete(path);
      else docs.set(path, await this.getBlob(h));
    }
    // An entry is kept only with its collection: a restore that would leave one without it (its collection deleted
    // outside the app since) cannot be saved.
    // Nor beside another entry with its ID (one added to another collection outside the app since).
    const restored = collectionsFromDocs([...docs].filter(([p]) => collectionPathOf(p)).map(([p, c]) => [p, JSON.parse(c)]));
    const unsaveable = restored.orphans.length ? `${restored.orphans[0]} would have no collection` : restored.duplicates.length ? `${restored.duplicates[0]} would share its entry ID with another entry` : null;
    if (unsaveable) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} "${entry.label}": ${unsaveable}.`, recoverable: false } };
    const next = docsToState(docs, this.state);
    // History restores only its own documents, and another may have changed outside the app since (a page now on
    // a route this restores, an old address kept there): never save a project that could not be opened again.
    const fatal = (s: ProjectState) => validateState(s, { sectionLinks: false }).filter((d) => d.severity === 'error' && FATAL_CODES.has(d.code));
    const already = new Set(fatal(this.state).map((d) => d.message));
    const broken = fatal(next).find((d) => !already.has(d.message));
    if (broken) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} "${entry.label}": ${broken.message}`, recoverable: false } };
    const pin = themePinProblem(next);
    if (pin) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} "${entry.label}": ${pin}`, recoverable: false } };
    // That check sees the project as loaded. An edit made outside the app that has not been loaded yet would slip
    // past it, so the restore waits for it.
    const unloaded = await this.unloadedEdit(new Set(Object.keys(entry.docs)));
    if (unloaded) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: `Cannot ${direction} "${entry.label}" yet: ${unloaded} changed outside the app. Try again in a moment.`, recoverable: true } };
    const cursor = this.history.cursor + (direction === 'undo' ? -1 : 1);
    try {
      // The cursor moves in the same journaled change as the documents, so a crash never separates them.
      await this.persist(next, { label: `${direction === 'undo' ? 'Undo' : 'Redo'} ${entry.label}`, history: false, cursor, source: 'user' });
    } catch (e) {
      if (e instanceof DiskConflictError) return { ok: false, revision: this.revision, error: this.diskConflict(e) };
      throw e;
    }
    this.emit('history');
    return { ok: true, revision: this.revision };
  }

  undo(): Promise<ApplyResult> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'Stop the AI before undoing.', recoverable: true } };
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      const entry = this.history.entries[this.history.cursor - 1];
      if (!entry) return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to undo.', recoverable: true } };
      return this.travel(entry, 'undo');
    });
  }

  redo(): Promise<ApplyResult> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'Stop the AI before redoing.', recoverable: true } };
      const blocked = await this.writeBlocked();
      if (blocked) return blocked;
      const entry = this.history.entries[this.history.cursor];
      if (!entry) return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to redo.', recoverable: true } };
      return this.travel(entry, 'redo');
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
      return this.travel(latest, 'undo');
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
      if (at === h.cursor - 1) return this.travel(entry, 'undo');
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
    const known = new Set(validateState(this.state, { sectionLinks: false }).filter(blocksSaving).map(diagnosticKey));
    const introduced = validateState(next, { sectionLinks: false }).filter((x) => blocksSaving(x) && !known.has(diagnosticKey(x)));
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

  // -------------------------------------------------------------------------
  // AI runs
  // -------------------------------------------------------------------------

  beginRun(runId: string): Promise<string | null> {
    return this.serialize(async () => {
      if (this.activeRun) return 'Another AI request is already running.';
      if (!(await this.stillOwner())) return this.readOnly?.reason ?? LOCK_UNCHECKED;
      if (this.unsettled) return UNSETTLED;
      if (this.pending.size) return 'A project file was changed outside SiteOrigin Builder. Resolve it in Project health first.';
      const before = new Map(this.docs);
      this.activeRun = { id: runId, before, beforeState: structuredClone(this.state), startRevision: this.revision, written: new Map() };
      await this.writeRunMarker();
      return null;
    });
  }

  /**
   * Record exactly which files the run has changed (or is about to change), with before and after hashes.
   * `written` lists every version the run has put in each file, so a crash between writing this marker and
   * publishing the batch (the file still holds the previous batch) is still recognised as the run's own work.
   */
  private async writeRunMarker(docs: Map<string, string> = this.docs) {
    if (!this.activeRun) return;
    const run = this.activeRun;
    const paths: Record<string, { before: string | null; after: string | null; written: Array<string | null> }> = {};
    const all = new Set([...run.before.keys(), ...docs.keys(), ...run.written.keys()]);
    for (const path of all) {
      const b = run.before.get(path);
      const a = docs.get(path);
      const after = a === undefined ? null : sha(a);
      const written = run.written.get(path) ?? new Set<string | null>();
      if (b !== a) written.add(after);
      if (written.size) run.written.set(path, written);
      if (b === a && !written.size) continue;
      paths[path] = { before: b === undefined ? null : await this.putBlob(b), after, written: [...written] };
    }
    await atomicWrite(this.local('sessions', 'active-run.json'), toJson({ id: run.id, paths }));
  }

  /** Did the active run change anything? */
  runChanged(): boolean {
    if (!this.activeRun) return false;
    if (this.activeRun.before.size !== this.docs.size) return true;
    for (const [p, c] of this.docs) if (this.activeRun.before.get(p) !== c) return true;
    return false;
  }

  /** Commit the run as one history group. */
  completeRun(label: string): Promise<boolean> {
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
      const planned = Object.keys(changed).length ? this.planHistory(changed, { label, source: 'ai', runId: run.id }, this.revision) : null;
      // From here a failure is settled by reopening: recovery either finishes the run or restores its checkpoint.
      this.activeRun = null;
      try {
        if (planned) {
          // The journal is the decision. Before it is on disk, a crash restores the checkpoint (the marker is still
          // there); once it is, recovery records the run's step and clears the marker, so the finished work is kept.
          await this.writeJournal({ writes: [], deletes: [], history: planned.history, revision: this.revision, finishRun: run.id });
        } else {
          // Nothing changed: restoring the checkpoint and keeping the run are the same thing.
          await removeDurable(this.local('sessions', 'active-run.json'));
        }
      } catch (e) {
        this.unsettled = true;
        throw e;
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
      if (planned && (planned.pruned || --this.gcCountdown <= 0)) await this.sweep();
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
   * Some files a cancelled run touched were changed outside the app. Every other file goes back to its pre-run
   * version; each changed file keeps its external version on disk, with the pre-run version held for the user to
   * choose (spec 18.5). The project's documents in memory are the pre-run state, which is always consistent.
   */
  private async revertAroundConflicts(run: NonNullable<ProjectSession['activeRun']>, touched: string[], changedOutside: string[]) {
    for (const p of touched) {
      const before = run.before.get(p) ?? null;
      const disk = await this.diskContent(p);
      // Checked again right before replacing it: a file saved elsewhere since the first check is held too.
      if (changedOutside.includes(p) || (disk !== before && disk !== (this.docs.get(p) ?? null))) {
        this.holdConflict(p, before, 'Changed outside SiteOrigin Builder during an AI run.');
        continue;
      }
      if (disk === before) continue;
      if (before === null) await this.removeCanonical(p);
      else await atomicWrite(safeJoin(this.dir, p), before);
    }
    this.state = run.beforeState;
    this.docs = new Map(run.before);
    await this.saveConflicts();
    const changedFiles = await this.publishGenerated(false);
    this.revision++;
    await this.saveLocalState();
    this.emit('changed', { revision: this.revision, changedDocs: touched, changedFiles, label: 'Revert AI changes', source: 'system' } satisfies SessionEvent);
  }

  // -------------------------------------------------------------------------
  // External changes
  // -------------------------------------------------------------------------

  /** Re-read canonical documents after an external edit, accepting them only when valid. */
  async reloadFromDisk(): Promise<{ ok: boolean; message?: string }> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, message: 'Busy' };
      if (this.readOnly) return this.reloadReadOnly();
      if (!(await this.stillOwner())) return this.readOnly ? this.reloadReadOnly() : { ok: false, message: LOCK_UNCHECKED };
      if (this.unsettled) return { ok: false, message: UNSETTLED };
      // A held conflict is settled outside the app when its file is put back to SiteOrigin Builder's version.
      let settled = false;
      for (const [p, builder] of [...this.pending]) {
        if (!settledOnDisk(p, await this.diskContent(p), builder)) continue;
        this.releaseConflict(p);
        settled = true;
      }
      if (settled) await this.saveConflicts();
      let next: ProjectState;
      let migrated: boolean;
      let stored: ProjectState;
      try {
        // Files still in conflict are read as SiteOrigin Builder's version until the user chooses.
        const read = await readProject(this.dir, { overlay: this.pending });
        next = read.state;
        stored = read.stored;
        migrated = !!read.migration;
      } catch (e) {
        if (settled) this.emit('history');
        return { ok: false, message: (e as Error).message };
      }
      const errors = this.introducedProblems(next);
      if (errors.length) return { ok: false, message: errors.map((e) => e.message).join(' ') };
      const pin = themePinProblem(next);
      if (pin) return { ok: false, message: `The changed files were not loaded: ${pin}` };
      // A component put back from an older copy (or one from before a theme update) can lack an option placements
      // chose since: loading it would quietly show them its default instead.
      // Documents put back from before variant axes come with their own choices, converted (and checked) by that step.
      const older = (doc: { schemaVersion?: unknown } | undefined) => !!doc && formatOf(doc) < AXES_FORMAT;
      const lost = choicesLost(this.state, next, (owner) => {
        const [kind, id] = owner.split(/:(.*)/s);
        return older(kind === 'shell' ? stored.site : kind === 'page' ? stored.pages[id] : stored.components[id]);
      });
      if (lost.length) return { ok: false, message: `The changed files were not loaded: ${lost[0]} Put back the matching page files too, or choose another option first.` };
      for (const def of Object.values(next.components)) {
        if (def.kind !== 'code' || def.source === this.state.components[def.id]?.source) continue;
        const bad = (await checkSvelteSource(def.source ?? '')).filter((p) => p.severity === 'error');
        if (bad.length) return { ok: false, message: `The edited code for "${def.name}" has problems, so it was not loaded: ${bad[0].message}` };
      }
      this.migrationDue = migrated;
      const nextDocs = stateToDocs(next);
      let same = nextDocs.size === this.docs.size;
      if (same) for (const [p, c] of nextDocs) if (this.docs.get(p) !== c) same = false;
      const srcSame = JSON.stringify([...stateToAuthoredSources(next)]) === JSON.stringify([...stateToAuthoredSources(this.state)]);
      if (same && srcSame) {
        // Only the stored format differs (a file put back from an older copy): store it in the current one.
        if (this.migrationDue && !this.pending.size) await this.publishMigration(3, this.state);
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
        if (b === a) continue;
        changed[p] = { before: b === undefined ? null : await this.putBlob(b), after: a === undefined ? null : await this.putBlob(a) };
      }
      this.state = next;
      this.docs = nextDocs;
      const changedFiles = await this.publishGenerated(false);
      this.revision++;
      if (Object.keys(changed).length) await this.recordHistory(changed, { label: 'External change', source: 'system' });
      await this.saveLocalState();
      if (this.migrationDue && !this.pending.size) await this.publishMigration(3, this.state);
      this.emit('changed', { revision: this.revision, changedDocs: Object.keys(changed), changedFiles, label: 'External change', source: 'system' } satisfies SessionEvent);
      return { ok: true };
    });
  }

  /** Read-only inspection follows the owner's edits without writing anything. */
  private async reloadReadOnly(): Promise<{ ok: boolean; message?: string }> {
    let next: ProjectState;
    try {
      next = await readState(this.dir, { allowNewer: true });
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
    const nextDocs = stateToDocs(next);
    if (nextDocs.size === this.docs.size && [...nextDocs].every(([p, c]) => this.docs.get(p) === c)) return { ok: true };
    const changedDocs = [...new Set([...nextDocs.keys(), ...this.docs.keys()])].filter((p) => nextDocs.get(p) !== this.docs.get(p));
    this.state = next;
    this.docs = nextDocs;
    this.revision++;
    this.emit('changed', { revision: this.revision, changedDocs, changedFiles: [], label: 'External change', source: 'system' } satisfies SessionEvent);
    return { ok: true };
  }

  async close() {
    await this.writing.catch(() => undefined);
    await this.releaseLock();
    this.removeAllListeners();
    this.generation.clear();
    this.seenOnDisk.clear();
    this.contentHashes.clear();
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

/** A held conflict is settled when the file on disk is Builder's version again: present or absent alike. */
function settledOnDisk(path: string, disk: string | null, builder: string | null): boolean {
  return (disk === null) === (builder === null) && sameContent(path, disk, builder);
}

/** Refuse to open a project written by a newer version for editing (it can still be opened read-only). */
async function assertKnownFormat(dir: string) {
  // Every document file is scanned on its own first: the full read stops at the first broken document, which may
  // sort before a newer one, and it keys documents by id, which a crafted id can hide.
  const newest = await newestStoredVersion(dir);
  if (newest > SCHEMA_VERSION) throw new ProjectFormatError(`This project was created by a newer version of SiteOrigin Builder (format ${newest}). Update the app to edit it.`, true);
  try {
    await readState(dir);
  } catch (e) {
    if (e instanceof ProjectFormatError && e.readOnly) throw e;
    // Anything else is reported by the normal open, after recovery has had its chance.
  }
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

/** A format version before this one: the first format had none. */
function olderFormat(v: unknown): boolean {
  return v === undefined || (Number.isInteger(v) && (v as number) > 0 && (v as number) < SCHEMA_VERSION);
}

/** Note in `h` each AI step of `dropped`, which History is letting go, as standing `status` (see HistoryFile.droppedRuns). */
function noteDropped(h: HistoryFile, dropped: Array<HistoryEntry | null | undefined>, status: DroppedRun) {
  const runs = dropped.flatMap((e) => (e && typeof e === 'object' && typeof e.runId === 'string' && e.runId ? [e.runId] : []));
  if (!runs.length) return;
  const map: Record<string, DroppedRun> = { ...h.droppedRuns };
  for (const runId of runs) {
    // The newest standing goes last, so the oldest are the first let go past the limit.
    delete map[runId];
    map[runId] = status;
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
    (o.side === 'external' || o.side === 'builder') &&
    typeof o.savedAt === 'number' &&
    Number.isFinite(o.savedAt) &&
    typeof o.file === 'string' &&
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

function sameContent(path: string, disk: string | null, expected: string | null): boolean {
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
function sameDocs(a: Map<string, string>, b: Map<string, string>, except?: string): boolean {
  for (const p of new Set([...a.keys(), ...b.keys()])) if (p !== except && a.get(p) !== b.get(p)) return false;
  return true;
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
