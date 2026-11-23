import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectState } from '@shared/types';
import { SCHEMA_VERSION } from '@shared/types';
import type { ApplyResult, EditBatch } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { applyOperations, captureClipboard, type Clipboard } from '@engine/apply';
import { listThemes } from '@catalogue/index';
import { EngineError } from '@engine/tree';
import { validateState, type Diagnostic } from '@engine/validate';
import { generateProject, GENERATOR_VERSION } from '@generator/index';
import { checkSvelteSource } from '../codecheck';
import { atomicWrite, readIfExists, readJson, removeEmptyDirs, safeJoin, sha, toJson } from './fsutil';
import { isCanonicalPath, ProjectFormatError, readProject, readState, stateToAuthoredSources, stateToDocs } from './documents';

export const LOCAL_DIR = '.siteorigin';
/** In the dev cache: hashes of the generated project files the dev variants stand in for. */
export const CLEAN_HASHES = '.clean-hashes.json';
const HISTORY_LIMIT = 100;
/** How often an open project refreshes its lock, and how long an unrefreshed lock is still trusted. */
export const LOCK_HEARTBEAT_MS = 30_000;
export const LOCK_STALE_MS = 2 * 60_000;
/** Files written by the asset importer: name-hash8.ext, plus -480w style responsive copies. */
const IMPORTED_ASSET_RE = /^[a-z0-9][a-z0-9-]*-[a-f0-9]{8}(-\d+w)?\.(jpg|png|webp|gif|avif|svg|woff2?)$/;
/** An imported file is never collected this soon after it was written (its asset may still be on its way in). */
const ASSET_GRACE_MS = 10 * 60_000;

/** The project is open in another live SiteOrigin Builder (on this or another computer). */
export class ProjectLockedError extends ProjectFormatError {
  constructor(message: string, public readonly owner: { host: string; since?: string }) {
    super(message);
  }
}

/** Why a project is open read-only. */
export interface ReadOnlyInfo {
  reason: string;
  /** The lock may belong to a crashed or unreachable app; the user can take it over. */
  canUnlock: boolean;
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
}

interface GeneratedManifest {
  generator: string;
  files: Record<string, string>;
}

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
}

/** A canonical file changed on disk since the app last read or wrote it. */
export class DiskConflictError extends Error {
  constructor(public path: string) {
    super(`${path} was changed outside SiteOrigin Builder. Your edit was not saved so the external change is kept.`);
  }
}

/** Validation codes that make a project unsafe to generate from. */
const FATAL_CODES = new Set(['HOME_MISSING', 'PAGE_MISSING', 'PAGE_ORPHAN', 'ROUTE_INVALID', 'ROUTE_DUPLICATE', 'HOME_ROUTE', 'NODE_MISSING', 'NODE_SHARED', 'DEF_MISSING']);

export interface Conflict {
  path: string;
  reason: string;
  /** canonical: a project document changed outside the app; generated: a derived source file was edited. */
  kind: 'canonical' | 'generated';
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
  conflicts: Conflict[] = [];
  /**
   * For each canonical document in conflict, the version SiteOrigin Builder holds (null = the document should not
   * exist). The in-memory state uses these versions; the external version stays on disk until the user chooses.
   */
  private pending = new Map<string, string | null>();
  /** Holds read back from conflicts.json when the project opened. */
  private loadedHolds = new Set<string>();
  recoveryNotes: string[] = [];
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
  /** What the editor last copied. Held only while this project is open; never saved. */
  private clipboard: Clipboard | null = null;

  constructor(public readonly dir: string) {
    super();
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

  static async open(dir: string, instanceId: string, opts: { force?: boolean } = {}): Promise<ProjectSession> {
    const s = new ProjectSession(dir);
    // A project from a newer version is never written to, not even its local folders.
    await assertKnownFormat(dir);
    // The lock comes first: recovery must never touch a project another window is editing, and a project
    // that turns out to be locked is opened read-only with nothing written.
    await fs.mkdir(s.local(), { recursive: true });
    const lockErr = await s.acquireLock(instanceId, opts.force);
    if (lockErr) throw lockErr;
    try {
      await s.ensureLocalDirs();
      await s.openLocked();
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
    const local = await readIfExists(s.local('state.json'));
    if (local) s.revision = JSON.parse(local).revision ?? 0;
    return s;
  }

  private async openLocked() {
    const s = this;
    const dir = this.dir;
    await s.loadConflicts();
    // Both recoveries run before the documents are first read: a file a crash left broken may be one they restore.
    await s.recoverJournal();
    await s.recoverInterruptedRun();
    const read = await readProject(dir, { overlay: s.pending });
    s.state = read.state;
    s.migrationDue = !!read.migration;
    s.docs = stateToDocs(s.state);
    s.history = usableHistory(await readIfExists(s.local('history', 'history.json')).then((t) => (t ? (JSON.parse(t) as HistoryFile) : null)));
    s.generated = (await readIfExists(join(dir, 'siteorigin', 'generated-manifest.json')).then((t) => (t ? JSON.parse(t) : null))) ?? s.generated;
    const local = await readIfExists(s.local('state.json'));
    if (local) s.revision = JSON.parse(local).revision ?? 0;
    // Validate the final state (after any rollback) before generating anything from it.
    const fatal = validateState(s.state).filter((d) => d.severity === 'error' && FATAL_CODES.has(d.code));
    if (fatal.length) throw new ProjectFormatError(`This project's documents are inconsistent, so it was not opened to protect your site: ${fatal.slice(0, 4).map((d) => d.message).join(' ')}`);
    // With a file in conflict the update waits: its stored version is the user's to choose first.
    if (s.migrationDue && !s.pending.size) await s.publishMigration();
    else await s.publishGenerated(false);
    await s.sweep();
  }

  /**
   * Store a project read in an older format in the current one. A copy of the old documents goes to the recovery
   * folder, then the update is published through the journal, so a crash leaves the old or new project, never a mix.
   */
  private async publishMigration() {
    if (this.migrationFailed) return;
    const read = await readProject(this.dir);
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
      if (stored === undefined) continue;
      before.set(path, stored);
      await atomicWrite(this.local('recovery', backup, path), stored);
    }
    const held = this.docs;
    this.docs = before;
    try {
      await this.persist(read.state, { label: 'Update project format', history: false, source: 'system' });
    } catch (e) {
      this.docs = held;
      this.migrationFailed = true;
      throw e;
    }
    this.migrationDue = false;
    await atomicWrite(this.local('history', 'history.json'), toJson(this.history));
    this.recoveryNotes.push(`Updated this project to the current format. A copy of the previous version is in .siteorigin/recovery/${backup}.`);
  }

  private async ensureLocalDirs() {
    for (const d of ['history/blobs', 'sessions', 'cache/dev', 'recovery']) await fs.mkdir(this.local(d), { recursive: true });
  }

  /** Acquire the per-project process lock. Returns an error message when another live process owns it. */
  private lockOwner: string | null = null;

  /**
   * The owner refreshes the lock every 30 seconds, so a lock left by a crash, by another computer or under an old
   * host name expires on its own; `force` takes it over at once (the user's "Unlock").
   */
  async acquireLock(instanceId: string, force = false): Promise<ProjectLockedError | null> {
    const lockPath = this.local('lock.json');
    const body = toJson({ pid: process.pid, host: hostname(), instance: instanceId, started: new Date().toISOString() });
    let owner: { host: string; since?: string } = { host: 'another computer' };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Exclusive create: two openers cannot both win.
        await fs.writeFile(lockPath, body, { flag: 'wx' });
        this.lockOwner = instanceId;
        this.startHeartbeat();
        return null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const existing = await readIfExists(lockPath);
      const judgedAt = (await fs.stat(lockPath).catch(() => null))?.mtimeMs;
      const age = Date.now() - ((await fs.stat(lockPath).catch(() => null))?.mtimeMs ?? 0);
      let stale = true;
      try {
        const l = JSON.parse(existing ?? '{}') as { pid: number; host: string; instance: string; started?: string };
        owner = { host: l.host === hostname() ? 'this computer' : String(l.host || 'another computer'), since: l.started };
        if (force || l.instance === instanceId) stale = true;
        // Not refreshed for a while: the owner crashed, is asleep or is gone. A PID alone is never trusted.
        else if (age > LOCK_STALE_MS) stale = true;
        else if (l.host === hostname()) {
          try {
            process.kill(l.pid, 0);
            stale = false; // a live process (possibly this one, in another session) holds it
          } catch {
            stale = true;
          }
        } else stale = false;
      } catch {
        // Unreadable: possibly another opener between creating the file and writing it, so only an old one is stale.
        stale = force || age > 10_000;
      }
      if (!stale) return new ProjectLockedError(`This project is already open in SiteOrigin Builder on ${owner.host}.`, owner);
      // Move the stale lock aside atomically: of two openers that both judged it stale, only one can move it.
      const aside = `${lockPath}.${randomBytes(4).toString('hex')}.stale`;
      try {
        await fs.rename(lockPath, aside);
      } catch {
        continue;
      }
      // If it changed after it was judged, it is another opener's fresh lock: put it back.
      // (A heartbeat changes only the time, so that is compared too.)
      if ((await readIfExists(aside)) !== existing || (await fs.stat(aside).catch(() => null))?.mtimeMs !== judgedAt) await fs.link(aside, lockPath).catch(() => undefined);
      await fs.rm(aside, { force: true });
    }
    return new ProjectLockedError('The project lock could not be acquired. Try again.', owner);
  }

  /** Before a write: is this session still the lock's owner? A takeover found here makes it read-only at once. */
  private async stillOwner(): Promise<boolean> {
    if (this.readOnly) return false;
    if (!this.lockOwner) return true; // a session that never took a lock (project creation, tests)
    await this.refreshLock();
    return !this.readOnly;
  }

  /** Keep the lock fresh, and notice when another app has taken it over (it was unlocked from elsewhere). */
  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => void this.refreshLock(), LOCK_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  /** Refresh the lock's timestamp; if another app now owns it, stop writing and become read-only. */
  async refreshLock() {
    if (!this.lockOwner) return;
    const lockPath = this.local('lock.json');
    const existing = await readIfExists(lockPath);
    let mine = false;
    try {
      mine = !!existing && JSON.parse(existing).instance === this.lockOwner;
    } catch {
      mine = false;
    }
    if (!mine) {
      this.stopHeartbeat();
      this.lockOwner = null;
      this.readOnly = { reason: 'Another SiteOrigin Builder took over this project, so it is read-only here. Close and reopen it to edit.', canUnlock: true };
      this.emit('lock-lost');
      this.emit('history');
      return;
    }
    const now = new Date();
    await fs.utimes(lockPath, now, now).catch(() => undefined);
  }

  private stopHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }

  async releaseLock() {
    this.stopHeartbeat();
    if (!this.lockOwner) return;
    const lockPath = this.local('lock.json');
    const existing = await readIfExists(lockPath);
    try {
      if (existing && JSON.parse(existing).instance !== this.lockOwner) return;
    } catch {
      /* unreadable: ours to remove */
    }
    await fs.rm(lockPath, { force: true });
    this.lockOwner = null;
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

  private async diskContent(path: string): Promise<string | null> {
    return readIfExists(safeJoin(this.dir, path));
  }

  private async removeCanonical(path: string) {
    const abs = safeJoin(this.dir, path);
    await fs.rm(abs, { force: true });
    await removeEmptyDirs(dirname(abs), join(this.dir, path.startsWith('src/') ? 'src' : 'siteorigin'));
  }

  // -------------------------------------------------------------------------
  // Canonical conflicts
  // -------------------------------------------------------------------------

  /** Hold Builder's version of a document whose file was changed outside the app, replacing any earlier hold. */
  private holdConflict(path: string, builder: string | null, reason: string) {
    this.pending.set(path, builder);
    this.conflicts = this.conflicts.filter((c) => c.path !== path);
    this.conflicts.push({ path, reason, kind: 'canonical' });
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
      if (!(await this.stillOwner())) return { ok: false, message: this.readOnly?.reason ?? 'This project is read-only.' };
      if (this.activeRun) return { ok: false, message: 'Stop the AI before resolving conflicts.' };
      if (this.migrationFailed) return { ok: false, message: 'This project could not be updated to the current format. Close and reopen it.' };
      const conflict = this.conflicts.find((c) => c.path === path);
      if (!conflict) return { ok: true };
      if (conflict.kind === 'generated') {
        if (choice !== 'restore') return { ok: false, message: 'A generated file can only be restored. Move your edits into the page or a code component.' };
        await this.restoreGeneratedLocked(path);
        return { ok: true };
      }
      const builder = this.pending.get(path) ?? null;
      const disk = await this.diskContent(path);
      const stamp = `${Date.now()}-${path.replace(/[\\/]/g, '__')}`;
      let changed: HistoryEntry['docs'] = {};
      if (choice === 'restore') {
        if (disk !== null) await atomicWrite(this.local('recovery', `${stamp}.external`), disk);
        if (builder === null) await this.removeCanonical(path);
        else await atomicWrite(safeJoin(this.dir, path), builder);
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
        const errors = validateState(next).filter((d) => d.severity === 'error');
        if (errors.length) return { ok: false, message: `Keeping the external version of ${path} would leave the site inconsistent: ${errors.slice(0, 3).map((d) => d.message).join(' ')} Restore SiteOrigin Builder's version instead, or fix the file.` };
        for (const def of Object.values(next.components)) {
          if (def.kind !== 'code' || def.source === this.state.components[def.id]?.source) continue;
          const bad = (await checkSvelteSource(def.source ?? '')).filter((p) => p.severity === 'error');
          if (bad.length) return { ok: false, message: `The external code for "${def.name}" has problems, so it was not kept: ${bad[0].message}` };
        }
        if (builder !== null) await atomicWrite(this.local('recovery', `${stamp}.builder`), builder);
        changed = await this.diffDocs(this.docs, stateToDocs(next));
        this.state = next;
        this.docs = stateToDocs(next);
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
      await fs.rm(this.local('journal.json'), { force: true });
      this.recoveryNotes.push(why);
    };
    let journal: { schemaVersion?: number; writes: Array<{ path: string; blob: string; before: string | null }>; deletes: Array<{ path: string; before: string }> };
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
    const contents = new Map<string, string>();
    for (const w of journal.writes) {
      const c = await this.getBlob(w.blob).catch(() => null);
      if (c === null) return keepAside('An interrupted save was missing data, so it was set aside. Your files were not changed.');
      contents.set(w.path, c);
    }
    if (bad) return keepAside('An interrupted save referred to files it should not touch, so it was set aside.');
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
    for (const d of journal.deletes) {
      if (this.loadedHolds.has(d.path)) {
        conflicts++;
        continue;
      }
      const disk = await this.diskContent(d.path);
      if (disk === null) continue;
      if (sha(disk) !== d.before) {
        conflicts++;
        this.holdConflict(d.path, null, 'Changed outside SiteOrigin Builder while a save was interrupted.');
        continue;
      }
      await this.removeCanonical(d.path);
    }
    // Held versions are recorded before the journal goes, so a second crash cannot lose them.
    await this.saveConflicts();
    await fs.rm(this.local('journal.json'), { force: true });
    this.recoveryNotes.push(
      conflicts
        ? `Finished an interrupted save. ${conflicts} file(s) had been changed outside the app and were kept as they are; choose which version to keep in Project health.`
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
    let run: { id: string; paths: Record<string, { before: string | null; after: string | null; written?: Array<string | null> }> };
    try {
      run = JSON.parse(marker);
    } catch {
      await fs.rm(this.local('sessions', 'active-run.json'), { force: true });
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
      // Any version the run itself wrote (an earlier batch, if it stopped between batches) is the run's to undo.
      // A hold saved by an earlier session is the user's pending choice: never decided for them here.
      const runWrote = !this.loadedHolds.has(path) && (h === d.after || (Array.isArray(d.written) && d.written.includes(h)));
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
    await fs.rm(this.local('sessions', 'active-run.json'), { force: true });
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  private async writeAllDocs() {
    this.docs = stateToDocs(this.state);
    for (const [path, content] of this.docs) await atomicWrite(safeJoin(this.dir, path), content);
  }

  /** Persist a new canonical state, regenerate derived files and record history. */
  private async persist(next: ProjectState, opts: CommitOptions & { runId?: string }): Promise<SessionEvent> {
    // Generate first: a generator failure must not leave canonical documents half-published.
    const generated = { clean: generateProject(next, { instrument: false }), dev: generateProject(next, { instrument: true }) };
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
    // Never overwrite a newer version on disk (for example an edit the file watcher has not delivered yet).
    for (const path of Object.keys(changed)) {
      if (!sameContent(path, await this.diskContent(path), this.docs.get(path) ?? null)) throw new DiskConflictError(path);
    }
    if (this.activeRun) await this.writeRunMarker(nextDocs);
    // Journal first, then replace files.
    if (writes.length || deletes.length) {
      await atomicWrite(this.local('journal.json'), toJson({ schemaVersion: SCHEMA_VERSION, writes: writes.map(({ path, blob, before }) => ({ path, blob, before })), deletes }));
      for (const w of writes) await atomicWrite(safeJoin(this.dir, w.path), w.content);
      for (const d of deletes) await this.removeCanonical(d.path);
    }
    this.state = next;
    this.docs = nextDocs;
    const changedFiles = await this.publishGenerated(false, generated);
    await fs.rm(this.local('journal.json'), { force: true });
    this.revision++;
    if (opts.history !== false && Object.keys(changed).length) await this.recordHistory(changed, opts);
    await this.saveLocalState();
    const event: SessionEvent = { revision: this.revision, changedDocs: Object.keys(changed), changedFiles, label: opts.label, source: opts.source ?? 'user' };
    this.emit('changed', event);
    return event;
  }

  /** Regenerate derived files. Files edited externally since the last generation are preserved and reported. */
  private async publishGenerated(initial: boolean, pre?: { clean: Map<string, string>; dev: Map<string, string> }): Promise<string[]> {
    const clean = pre?.clean ?? generateProject(this.state, { instrument: false });
    const dev = pre?.dev ?? generateProject(this.state, { instrument: true });
    const devRoot = this.local('cache', 'dev');
    const changedFiles: string[] = [];
    const prev = this.generated.files;
    const nextFiles: Record<string, string> = {};
    const authored = new Set(stateToAuthoredSources(this.state).keys());
    this.conflicts = this.conflicts.filter((c) => c.kind !== 'generated');
    // Decide first which project files are someone else's now, so no editor variant shadows them in the preview.
    const plan: Array<{ path: string; content: string; abs: string }> = [];
    for (const [path, content] of clean) {
      if (authored.has(path)) continue;
      const h = sha(content);
      nextFiles[path] = h;
      const abs = safeJoin(this.dir, path);
      const disk = await readIfExists(abs);
      const diskHash = disk === null ? null : sha(disk);
      if (diskHash === h) continue;
      if (!initial && disk !== null && prev[path] && diskHash !== prev[path]) {
        // Edited outside the app: keep the external version.
        nextFiles[path] = prev[path];
        this.conflicts.push({ path, reason: 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.', kind: 'generated' });
        continue;
      }
      if (!initial && disk !== null && !prev[path]) {
        // A file we never wrote already lives here: never overwrite someone's own work.
        delete nextFiles[path];
        this.conflicts.push({ path, reason: 'Generated file would replace a file that SiteOrigin Builder did not create. Move or delete that file, then restore.', kind: 'generated' });
        continue;
      }
      plan.push({ path, content, abs });
    }
    const keptExternal = new Set(this.conflicts.filter((c) => c.kind === 'generated').map((c) => c.path));
    // Dev variants (with editor identity attributes, never part of the portable source) are written before the
    // project files, so the dev server never loads a stale instrumented file. A file kept as edited outside the
    // app has no variant: the preview shows the external version, as the exported site would.
    for (const [path, content] of dev) {
      if (authored.has(path)) continue;
      const abs = safeJoin(devRoot, path);
      if (keptExternal.has(path)) {
        if (existsSync(abs)) {
          await fs.rm(abs, { force: true });
          // The preview may have cached the variant; touching the real file makes it load that file instead.
          const now = new Date();
          await fs.utimes(safeJoin(this.dir, path), now, now).catch(() => undefined);
        }
        continue;
      }
      const disk = await readIfExists(abs);
      if (disk !== content) await atomicWrite(abs, content);
    }
    // The preview serves a variant only while the project file is the one generated here; written before the
    // project files, so a file mid-publication is never mistaken for an edit made outside the app.
    const cleanHashes: Record<string, string> = {};
    for (const [path, content] of clean) if (!authored.has(path)) cleanHashes[path] = sha(content);
    await atomicWrite(join(devRoot, CLEAN_HASHES), JSON.stringify(cleanHashes));
    for (const { path, content, abs } of plan) {
      await atomicWrite(abs, content);
      changedFiles.push(path);
    }
    // Remove files that are no longer generated.
    for (const path of Object.keys(prev)) {
      if (path in nextFiles) continue;
      const abs = safeJoin(this.dir, path);
      const disk = await readIfExists(abs);
      await fs.rm(safeJoin(devRoot, path), { force: true });
      // An obsolete file that was edited outside the app is left alone and no longer owned.
      if (disk !== null && sha(disk) === prev[path]) {
        await fs.rm(abs, { force: true });
        await removeEmptyDirs(dirname(abs), join(this.dir, 'src'));
        changedFiles.push(path);
      }
    }
    this.generated = { generator: GENERATOR_VERSION, files: nextFiles };
    await atomicWrite(join(this.dir, 'siteorigin', 'generated-manifest.json'), toJson({ generator: GENERATOR_VERSION, note: 'Hashes of files generated by SiteOrigin Builder.', files: Object.fromEntries(Object.entries(nextFiles).sort()) }));
    return changedFiles;
  }

  /** Restore a generated file from the managed documents, discarding the external edit. */
  restoreGeneratedFile(path: string): Promise<void> {
    return this.serialize(async () => {
      if (!(await this.stillOwner())) throw new Error(this.readOnly?.reason ?? 'This project is read-only.');
      await this.restoreGeneratedLocked(path);
    });
  }

  /** Writes are refused while the project is read-only or a project document is in conflict. */
  private async writeBlocked(): Promise<ApplyResult | null> {
    await this.stillOwner();
    if (this.readOnly) return { ok: false, revision: this.revision, error: { code: 'SCOPE_MISMATCH', message: this.readOnly.reason, recoverable: false } };
    if (this.pending.size) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: 'Resolve the file conflicts in Project health before making more changes.', recoverable: false } };
    // A new save would replace the journal the failed update left.
    if (this.migrationFailed) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: 'This project could not be updated to the current format. Close and reopen it.', recoverable: false } };
    return null;
  }

  private async restoreGeneratedLocked(path: string) {
    const clean = generateProject(this.state, { instrument: false });
    const content = clean.get(path);
    if (content === undefined) throw new Error('That file is no longer generated.');
    const abs = safeJoin(this.dir, path);
    const disk = await readIfExists(abs);
    if (disk !== null) await atomicWrite(this.local('recovery', `${Date.now()}-${path.replace(/[\\/]/g, '__')}`), disk);
    await atomicWrite(abs, content);
    this.generated.files[path] = sha(content);
    this.conflicts = this.conflicts.filter((c) => c.path !== path);
    await this.publishGenerated(false);
    this.emit('changed', { revision: this.revision, changedDocs: [], changedFiles: [path], label: 'Restore generated file', source: 'user' } satisfies SessionEvent);
  }

  private async saveLocalState() {
    await atomicWrite(this.local('state.json'), toJson({ revision: this.revision }));
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Run `fn` while holding the writer lock, so no edit or regeneration lands while it reads the project. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.serialize(fn);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.writing.then(fn, fn);
    this.writing = p.catch(() => undefined);
    return p;
  }

  /**
   * Take a copy of page content for the editor's Paste, as it is now, so the paste does not depend on the
   * original. `expectedRevision` is the revision the editor showed when Copy was pressed: a change that landed
   * since (another window, a file edited outside the app) could make the copy differ from what was on screen.
   */
  copy(pageId: string, nodeId: string, expectedRevision?: number): Promise<{ ok: boolean; clipboardId?: string; message?: string }> {
    return this.serialize(async () => {
      if (expectedRevision !== undefined && expectedRevision !== this.revision) return { ok: false, message: 'The project changed while copying. Copy it again.' };
      try {
        this.clipboard = captureClipboard(this.state, pageId, nodeId);
        return { ok: true, clipboardId: this.clipboard.id };
      } catch (e) {
        if (e instanceof EngineError) return { ok: false, message: e.message };
        throw e;
      }
    });
  }

  /**
   * Validate and apply an edit batch. `runId` identifies the AI run that holds the writer lock;
   * manual edits are rejected while a run is active.
   */
  apply(batch: EditBatch, opts: CommitOptions & { runId?: string; idempotencyKey?: string }): Promise<ApplyResult> {
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
      // Paste places what the editor copied; an AI run never sends it.
      if ((opts.source === 'ai' || opts.runId) && ops.some((o) => o.type === 'node.paste'))
        return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'node.paste is only for the editor. Use node.copy.', recoverable: true } };
      let next: ProjectState;
      let results;
      try {
        ({ state: next, results } = applyOperations(this.state, ops, { clipboard: this.clipboard }));
      } catch (e) {
        if (e instanceof EngineError) return { ok: false, revision: this.revision, error: { code: e.code, message: e.message, recoverable: true, details: e.details } };
        return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: (e as Error).message, recoverable: true } };
      }
      // Any authored code that is new or changed must pass the safety checks before it can be saved.
      for (const def of Object.values(next.components)) {
        if (def.kind !== 'code' || def.source === undefined || this.state.components[def.id]?.source === def.source) continue;
        // Placing a theme's own component (the contact form, say) authors no code: it ships with the app.
        if (def.owner === 'theme' && listThemes().some((t) => t.components.some((c) => c.id === def.id && c.source === def.source))) continue;
        // Code the AI writes is held to a stricter policy than code a developer writes.
        const errors = (await checkSvelteSource(def.source, { strict: opts.source === 'ai' })).filter((p) => p.severity === 'error');
        if (errors.length)
          return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: `The code for "${def.name}" has problems: ${errors.map((e) => (e.line ? `line ${e.line}: ` : '') + e.message).join(' ')}`, recoverable: true, details: errors } };
      }
      const before = validateState(this.state).filter((d) => d.severity === 'error').map((d) => d.message);
      const introduced = validateState(next).filter((d) => d.severity === 'error' && !before.includes(d.message));
      if (introduced.length)
        return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: introduced.map((d) => d.message).join(' '), recoverable: true, details: introduced } };
      let ev: SessionEvent;
      try {
        ev = await this.persist(next, opts);
      } catch (e) {
        if (e instanceof DiskConflictError) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: e.message, recoverable: true } };
        throw e;
      }
      const result: ApplyResult = { ok: true, revision: this.revision, results, changed: ev.changedDocs };
      if (opts.idempotencyKey) this.idempotency.set(opts.idempotencyKey, { fingerprint, result });
      return result;
    });
  }

  /** Document problems. File conflicts are reported separately (`conflicts`), with their actions, never twice. */
  diagnostics(): Diagnostic[] {
    try {
      return validateState(this.state);
    } catch (e) {
      // A project from a newer version may not follow this version's shapes; it is open read-only anyway.
      if (this.readOnly) return [];
      throw e;
    }
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  private async recordHistory(docs: HistoryEntry['docs'], opts: CommitOptions & { runId?: string }) {
    const h = this.history;
    h.entries = h.entries.slice(0, h.cursor);
    const last = h.entries[h.entries.length - 1];
    if (opts.coalesceKey && last?.coalesceKey === opts.coalesceKey && Date.now() - Date.parse(last.time) < 4000) {
      for (const [path, d] of Object.entries(docs)) {
        if (last.docs[path]) last.docs[path].after = d.after;
        else last.docs[path] = d;
      }
      last.time = new Date().toISOString();
      last.revision = this.revision;
    } else {
      h.entries.push({
        id: `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        label: opts.label,
        source: opts.source ?? 'user',
        time: new Date().toISOString(),
        revision: this.revision,
        docs,
        coalesceKey: opts.coalesceKey,
        runId: opts.runId
      });
    }
    const pruned = h.entries.length > HISTORY_LIMIT;
    if (pruned) h.entries = h.entries.slice(h.entries.length - HISTORY_LIMIT);
    h.cursor = h.entries.length;
    await atomicWrite(this.local('history', 'history.json'), toJson(h));
    // Collect when history was pruned, and every so often for blobs left by provisional AI batches and undo.
    if (pruned || --this.gcCountdown <= 0) await this.sweep();
  }

  /** Asset imports in progress: their files are written before their asset records, so no sweep runs meanwhile. */
  private importing = 0;
  async withImport<T>(fn: () => Promise<T>): Promise<T> {
    this.importing++;
    try {
      return await fn();
    } finally {
      this.importing--;
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
    if (!(await this.stillOwner())) return;
    this.gcCountdown = 25;
    try {
      await this.collectGarbageNow();
    } catch {
      /* best effort: a failed sweep is retried next time */
    }
  }

  private async collectGarbageNow() {
    const blobDir = this.local('history', 'blobs');
    const names = await fs.readdir(blobDir).catch(() => [] as string[]);
    const sizes = new Map<string, number>();
    for (const n of names) {
      const m = n.match(/^([a-f0-9]{64})\.json$/);
      if (m) sizes.set(m[1], (await fs.stat(join(blobDir, n)).catch(() => null))?.size ?? 0);
    }
    // Recovery material that is never pruned: the active run's pre-run documents and held conflict versions.
    const pinned = new Set<string>();
    for (const c of this.activeRun?.before.values() ?? []) pinned.add(sha(c));
    for (const c of this.pending.values()) if (c !== null) pinned.add(sha(c));
    const entryBlobs = (e: HistoryEntry) => Object.values(e.docs).flatMap((d) => [d.before, d.after]).filter((x): x is string => !!x);
    const total = () => {
      const all = new Set([...pinned, ...this.history.entries.flatMap(entryBlobs)]);
      let bytes = 0;
      for (const b of all) bytes += sizes.get(b) ?? 0;
      return bytes;
    };
    let dropped = 0;
    while (this.history.entries.length > 1 && total() > this.historyByteLimit) {
      // The oldest applied group goes first. With nothing applied, trim redo from its far end instead:
      // dropping the first redo group would leave the next one expecting documents that never return.
      if (this.history.cursor > 0) {
        this.history.entries.shift();
        this.history.cursor--;
      } else this.history.entries.pop();
      dropped++;
    }
    if (dropped) {
      await atomicWrite(this.local('history', 'history.json'), toJson(this.history));
      this.emit('history');
    }
    const keep = new Set([...pinned, ...this.history.entries.flatMap(entryBlobs)]);
    // A journal, a run marker or a conflict list on disk may name blobs too (written by this session or a crash).
    for (const f of [this.local('journal.json'), this.local('sessions', 'active-run.json'), this.local('conflicts.json')]) {
      const t = await readIfExists(f);
      if (t) for (const m of t.matchAll(/[a-f0-9]{64}/g)) keep.add(m[0]);
    }
    for (const b of sizes.keys()) if (!keep.has(b)) await fs.rm(join(blobDir, `${b}.json`), { force: true });
    if (!this.importing) await this.collectAssets(keep);
  }

  /** Delete imported files in static/assets/ that no retained version of assets.json and no code refers to. */
  private async collectAssets(blobs: Set<string>) {
    // Only a real folder inside the project is ever swept, never one a link (at any level) points elsewhere.
    let assetsDir: string;
    try {
      assetsDir = safeJoin(this.dir, 'static/assets');
    } catch {
      return;
    }
    if (!(await fs.lstat(assetsDir).catch(() => null))?.isDirectory()) return;
    const files = await fs.readdir(assetsDir).catch(() => [] as string[]);
    if (!files.length) return;
    const referenced = new Set<string>();
    const addDoc = (text: string | null | undefined) => {
      if (!text) return;
      try {
        const doc = JSON.parse(text) as ProjectState['assets'];
        for (const a of Object.values(doc.assets ?? {})) {
          if (typeof a?.file === 'string') referenced.add(a.file);
          for (const v of a?.variants ?? []) if (typeof v?.file === 'string') referenced.add(v.file);
        }
      } catch {
        /* not an assets document */
      }
    };
    const ASSETS_DOC = 'siteorigin/assets.json';
    addDoc(toJson(this.state.assets));
    addDoc(await this.diskContent(ASSETS_DOC));
    addDoc(this.activeRun?.before.get(ASSETS_DOC));
    addDoc(this.pending.get(ASSETS_DOC));
    // Code components may point at a file by URL; any mention in any version that can come back keeps it.
    const code = Object.values(this.state.components).map((d) => d.source ?? '');
    for (const [p, c] of [...(this.activeRun?.before ?? []), ...this.pending]) if (p.endsWith('.svelte') && c) code.push(c);
    for (const e of this.history.entries) {
      for (const [p, d] of Object.entries(e.docs)) {
        if (p !== ASSETS_DOC && !p.endsWith('.svelte')) continue;
        for (const h of [d.before, d.after]) {
          if (!h || !blobs.has(h)) continue;
          const text = await this.getBlob(h).catch(() => null);
          if (p === ASSETS_DOC) addDoc(text);
          else if (text) code.push(text);
        }
      }
    }
    // A conflict list or run marker on disk may name an assets.json version too.
    for (const f of [this.local('sessions', 'active-run.json'), this.local('conflicts.json')]) {
      const t = await readIfExists(f);
      if (t) for (const m of t.matchAll(/[a-f0-9]{64}/g)) if (blobs.has(m[0])) addDoc(await this.getBlob(m[0]).catch(() => null));
    }
    // Both sides of a held conflict: the file on disk may be kept.
    for (const p of this.pending.keys()) if (p.endsWith('.svelte')) code.push((await this.diskContent(p)) ?? '');
    const allCode = code.join('\n');
    for (const f of files) {
      if (!IMPORTED_ASSET_RE.test(f) || referenced.has(`static/assets/${f}`) || allCode.includes(f)) continue;
      const abs = join(assetsDir, f);
      const st = await fs.lstat(abs).catch(() => null);
      if (!st?.isFile() || Date.now() - st.mtimeMs < ASSET_GRACE_MS) continue;
      await fs.rm(abs, { force: true });
    }
  }

  historyInfo() {
    const h = this.history;
    return {
      canUndo: h.cursor > 0 && !this.activeRun,
      canRedo: h.cursor < h.entries.length && !this.activeRun,
      undoLabel: h.entries[h.cursor - 1]?.label,
      redoLabel: h.entries[h.cursor]?.label,
      entries: h.entries.map((e, i) => ({ id: e.id, label: e.label, source: e.source, time: e.time, applied: i < h.cursor, runId: e.runId }))
    };
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
    const next = docsToState(docs, this.state);
    try {
      await this.persist(next, { label: `${direction === 'undo' ? 'Undo' : 'Redo'} ${entry.label}`, history: false, source: 'user' });
    } catch (e) {
      if (e instanceof DiskConflictError) return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: e.message, recoverable: true } };
      throw e;
    }
    this.history.cursor += direction === 'undo' ? -1 : 1;
    await atomicWrite(this.local('history', 'history.json'), toJson(this.history));
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

  // -------------------------------------------------------------------------
  // AI runs
  // -------------------------------------------------------------------------

  beginRun(runId: string): Promise<string | null> {
    return this.serialize(async () => {
      if (this.activeRun) return 'Another AI request is already running.';
      if (!(await this.stillOwner())) return this.readOnly?.reason ?? 'This project is read-only.';
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
      // Another app took the project over: its own recovery decides what happens to this run's files.
      if (!(await this.stillOwner())) {
        this.activeRun = null;
        return false;
      }
      const changed: HistoryEntry['docs'] = {};
      const paths = new Set([...run.before.keys(), ...this.docs.keys()]);
      for (const p of paths) {
        const b = run.before.get(p);
        const a = this.docs.get(p);
        if (b === a) continue;
        changed[p] = { before: b === undefined ? null : await this.putBlob(b), after: a === undefined ? null : await this.putBlob(a) };
      }
      this.activeRun = null;
      // Clear the marker first: a crash after this point keeps the finished work rather than reverting it.
      await fs.rm(this.local('sessions', 'active-run.json'), { force: true });
      if (Object.keys(changed).length) await this.recordHistory(changed, { label, source: 'ai', runId: run.id });
      this.emit('history');
      return Object.keys(changed).length > 0;
    });
  }

  /** Restore the pre-run state (failure or cancellation). */
  abortRun(): Promise<{ restored: boolean; conflict?: string }> {
    return this.serialize(async () => {
      const run = this.activeRun;
      if (!run) return { restored: false };
      if (!(await this.stillOwner())) {
        this.activeRun = null;
        return { restored: false };
      }
      // Verify, byte for byte, that every file the run touched still holds what the run wrote.
      const touched = [...new Set([...run.before.keys(), ...this.docs.keys()])].filter((p) => run.before.get(p) !== this.docs.get(p));
      const changedOutside: string[] = [];
      for (const p of touched) if ((await this.diskContent(p)) !== (this.docs.get(p) ?? null)) changedOutside.push(p);
      this.activeRun = null;
      if (touched.length && !changedOutside.length) {
        try {
          await this.persist(run.beforeState, { label: 'Revert AI changes', history: false, source: 'system' });
        } catch (e) {
          if (!(e instanceof DiskConflictError)) throw e;
          changedOutside.push(e.path);
        }
      }
      if (changedOutside.length) await this.revertAroundConflicts(run, touched, changedOutside);
      await fs.rm(this.local('sessions', 'active-run.json'), { force: true });
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
      if (this.readOnly || !(await this.stillOwner())) return this.reloadReadOnly();
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
      try {
        // Files still in conflict are read as SiteOrigin Builder's version until the user chooses.
        const read = await readProject(this.dir, { overlay: this.pending });
        next = read.state;
        migrated = !!read.migration;
      } catch (e) {
        if (settled) this.emit('history');
        return { ok: false, message: (e as Error).message };
      }
      const errors = validateState(next).filter((d) => d.severity === 'error');
      if (errors.length) return { ok: false, message: errors.map((e) => e.message).join(' ') };
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
        if (this.migrationDue && !this.pending.size) await this.publishMigration();
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
      if (this.migrationDue && !this.pending.size) await this.publishMigration();
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
  }
}

/** A held conflict is settled when the file on disk is Builder's version again: present or absent alike. */
function settledOnDisk(path: string, disk: string | null, builder: string | null): boolean {
  return (disk === null) === (builder === null) && sameContent(path, disk, builder);
}

/** Refuse to open a project written by a newer version for editing (it can still be opened read-only). */
async function assertKnownFormat(dir: string) {
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

function emptyHistory(): HistoryFile {
  return { schemaVersion: SCHEMA_VERSION, entries: [], cursor: 0 };
}

/**
 * Undo steps hold whole documents, so they are only usable in the format they were written in. History from an
 * older format is dropped when it is read, which also covers a crash partway through updating the project.
 */
function usableHistory(file: HistoryFile | null): HistoryFile {
  return file && file.schemaVersion === SCHEMA_VERSION ? file : emptyHistory();
}

/** Compare disk content with the expected document, ignoring JSON formatting and treating a missing authored source as empty. */
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
    components: {}
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
