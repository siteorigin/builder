import { EventEmitter } from 'node:events';
import { promises as fs, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProjectState } from '@shared/types';
import type { ApplyResult, EditBatch } from '@shared/ops';
import { validateOperation } from '@shared/ops';
import { applyOperations } from '@engine/apply';
import { EngineError } from '@engine/tree';
import { validateState, type Diagnostic } from '@engine/validate';
import { generateProject, GENERATOR_VERSION } from '@generator/index';
import { checkSvelteSource } from '../codecheck';
import { atomicWrite, readIfExists, readJson, removeEmptyDirs, safeJoin, sha, toJson } from './fsutil';
import { isCanonicalPath, ProjectFormatError, readState, stateToAuthoredSources, stateToDocs } from './documents';

export const LOCAL_DIR = '.siteorigin';
const HISTORY_LIMIT = 100;

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
}

/**
 * One open, writable project. Owns canonical state, the revision counter, history,
 * the publication journal and generated output. All writes pass through `apply` or `commitState`.
 */
export class ProjectSession extends EventEmitter {
  state!: ProjectState;
  revision = 0;
  private docs = new Map<string, string>();
  private history: HistoryFile = { entries: [], cursor: 0 };
  private generated: GeneratedManifest = { generator: GENERATOR_VERSION, files: {} };
  conflicts: Conflict[] = [];
  recoveryNotes: string[] = [];
  /** Run currently holding the writer lock. */
  activeRun: { id: string; before: Map<string, string>; beforeState: ProjectState; startRevision: number } | null = null;
  private writing: Promise<unknown> = Promise.resolve();
  private idempotency = new Map<string, { fingerprint: string; result: ApplyResult }>();

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

  static async open(dir: string, instanceId: string): Promise<ProjectSession> {
    const s = new ProjectSession(dir);
    await s.ensureLocalDirs();
    // The lock comes first: recovery must never touch a project another window is editing.
    const lockErr = await s.acquireLock(instanceId);
    if (lockErr) throw new ProjectFormatError(lockErr);
    try {
      await s.openLocked();
    } catch (e) {
      await s.releaseLock();
      throw e;
    }
    return s;
  }

  private async openLocked() {
    const s = this;
    const dir = this.dir;
    await s.recoverJournal();
    s.state = await readState(dir);
    s.docs = stateToDocs(s.state);
    s.history = (await readIfExists(s.local('history', 'history.json')).then((t) => (t ? (JSON.parse(t) as HistoryFile) : null))) ?? { entries: [], cursor: 0 };
    s.generated = (await readIfExists(join(dir, 'siteorigin', 'generated-manifest.json')).then((t) => (t ? JSON.parse(t) : null))) ?? s.generated;
    const local = await readIfExists(s.local('state.json'));
    if (local) s.revision = JSON.parse(local).revision ?? 0;
    await s.recoverInterruptedRun();
    // Validate the final state (after any rollback) before generating anything from it.
    const fatal = validateState(s.state).filter((d) => d.severity === 'error' && FATAL_CODES.has(d.code));
    if (fatal.length) throw new ProjectFormatError(`This project's documents are inconsistent, so it was not opened to protect your site: ${fatal.slice(0, 4).map((d) => d.message).join(' ')}`);
    await s.publishGenerated(false);
  }

  private async ensureLocalDirs() {
    for (const d of ['history/blobs', 'sessions', 'cache/dev', 'recovery']) await fs.mkdir(this.local(d), { recursive: true });
  }

  /** Acquire the per-project process lock. Returns an error message when another live process owns it. */
  private lockOwner: string | null = null;

  async acquireLock(instanceId: string): Promise<string | null> {
    const lockPath = this.local('lock.json');
    const body = toJson({ pid: process.pid, host: hostname(), instance: instanceId, started: new Date().toISOString() });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Exclusive create: two openers cannot both win.
        await fs.writeFile(lockPath, body, { flag: 'wx' });
        this.lockOwner = instanceId;
        return null;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const existing = await readIfExists(lockPath);
      let stale = true;
      try {
        const l = JSON.parse(existing ?? '{}') as { pid: number; host: string; instance: string };
        if (l.instance === instanceId) stale = true;
        else if (l.host === hostname()) {
          try {
            process.kill(l.pid, 0);
            stale = false; // a live process (possibly this one, in another session) holds it
          } catch {
            stale = true;
          }
        } else stale = false;
      } catch {
        stale = true;
      }
      if (!stale) return 'This project is already open in another SiteOrigin Builder window.';
      await fs.rm(lockPath, { force: true });
    }
    return 'The project lock could not be acquired. Try again.';
  }

  async releaseLock() {
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

  /** Roll forward an interrupted publication: every intended write is stored as a blob before any file is replaced. */
  private async recoverJournal() {
    const j = await readIfExists(this.local('journal.json'));
    if (!j) return;
    const keepAside = async (why: string) => {
      await atomicWrite(this.local('recovery', `journal-${Date.now()}.json`), j);
      await fs.rm(this.local('journal.json'), { force: true });
      this.recoveryNotes.push(why);
    };
    let journal: { writes: Array<{ path: string; blob: string; before: string | null }>; deletes: Array<{ path: string; before: string }> };
    try {
      journal = JSON.parse(j);
    } catch {
      return keepAside('An interrupted save could not be read, so it was set aside. Your files were not changed.');
    }
    // Only well-formed journals for canonical documents, with verified blobs, are ever replayed.
    if (!journal || !Array.isArray(journal.writes) || !Array.isArray(journal.deletes)) return keepAside('An interrupted save could not be read, so it was set aside. Your files were not changed.');
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
      const disk = await this.diskContent(w.path);
      const h = disk === null ? null : sha(disk);
      if (h === w.blob) continue; // already applied
      if (h !== w.before) {
        conflicts++;
        continue; // changed by someone else since: keep their version
      }
      await atomicWrite(safeJoin(this.dir, w.path), contents.get(w.path)!);
    }
    for (const d of journal.deletes) {
      const disk = await this.diskContent(d.path);
      if (disk === null) continue;
      if (sha(disk) !== d.before) {
        conflicts++;
        continue;
      }
      await this.removeCanonical(d.path);
    }
    await fs.rm(this.local('journal.json'), { force: true });
    this.recoveryNotes.push(
      conflicts
        ? `Finished an interrupted save. ${conflicts} file(s) had been changed outside the app and were kept as they are.`
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
    let run: { id: string; paths: Record<string, { before: string | null; after: string | null }> };
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
      if (h === d.before) continue; // never written, or already restored
      if (h !== d.after) {
        conflicts.push(path);
        continue;
      }
      const before = d.before === null ? null : await this.getBlob(d.before).catch(() => undefined);
      if (before === undefined) {
        conflicts.push(path);
        continue;
      }
      if (before === null) await this.removeCanonical(path);
      else await atomicWrite(safeJoin(this.dir, path), before);
      restored++;
    }
    if (restored) {
      this.state = await readState(this.dir);
      this.docs = stateToDocs(this.state);
    }
    if (conflicts.length) {
      this.recoveryNotes.push(`An interrupted AI change was only partly reverted: ${conflicts.length} file(s) were changed outside the app and were kept.`);
      this.conflicts.push(...conflicts.map((p) => ({ path: p, reason: 'Changed outside SiteOrigin Builder during an interrupted AI run.' })));
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
      await atomicWrite(this.local('journal.json'), toJson({ writes: writes.map(({ path, blob, before }) => ({ path, blob, before })), deletes }));
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
    this.conflicts = this.conflicts.filter((c) => !c.reason.startsWith('Generated file'));
    // Dev variants are written first so the dev server never loads a stale instrumented file.
    // Dev variants with editor identity attributes (never part of the portable source).
    for (const [path, content] of dev) {
      if (authored.has(path)) continue;
      const abs = safeJoin(devRoot, path);
      const disk = await readIfExists(abs);
      if (disk !== content) await atomicWrite(abs, content);
    }
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
        this.conflicts.push({ path, reason: 'Generated file was edited outside SiteOrigin Builder. Restore it to resume generation.' });
        continue;
      }
      if (!initial && disk !== null && !prev[path]) {
        // A file we never wrote already lives here: never overwrite someone's own work.
        delete nextFiles[path];
        this.conflicts.push({ path, reason: 'Generated file would replace a file that SiteOrigin Builder did not create. Move or delete that file, then restore.' });
        continue;
      }
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
    return this.serialize(() => this.restoreGeneratedLocked(path));
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

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.writing.then(fn, fn);
    this.writing = p.catch(() => undefined);
    return p;
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
      if (this.conflicts.some((c) => c.reason.startsWith('Changed outside')))
        return { ok: false, revision: this.revision, error: { code: 'CONFLICT', message: 'Resolve the file conflicts before making more changes.', recoverable: false } };
      const ops = [];
      for (const raw of batch.operations) {
        const v = validateOperation(raw);
        if (!v.ok) return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: v.message, recoverable: true } };
        ops.push(v.op);
      }
      let next: ProjectState;
      let results;
      try {
        ({ state: next, results } = applyOperations(this.state, ops));
      } catch (e) {
        if (e instanceof EngineError) return { ok: false, revision: this.revision, error: { code: e.code, message: e.message, recoverable: true, details: e.details } };
        return { ok: false, revision: this.revision, error: { code: 'VALIDATION_FAILED', message: (e as Error).message, recoverable: true } };
      }
      // Any authored code that is new or changed must pass the safety checks before it can be saved.
      for (const def of Object.values(next.components)) {
        if (def.kind !== 'code' || def.source === undefined || this.state.components[def.id]?.source === def.source) continue;
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

  diagnostics(): Diagnostic[] {
    const out = validateState(this.state);
    for (const c of this.conflicts) out.push({ severity: 'error', code: 'CONFLICT', message: `${c.path}: ${c.reason}` });
    return out;
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
    if (h.entries.length > HISTORY_LIMIT) h.entries = h.entries.slice(h.entries.length - HISTORY_LIMIT);
    h.cursor = h.entries.length;
    await atomicWrite(this.local('history', 'history.json'), toJson(h));
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
      const entry = this.history.entries[this.history.cursor - 1];
      if (!entry) return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to undo.', recoverable: true } };
      return this.travel(entry, 'undo');
    });
  }

  redo(): Promise<ApplyResult> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'Stop the AI before redoing.', recoverable: true } };
      const entry = this.history.entries[this.history.cursor];
      if (!entry) return { ok: false, revision: this.revision, error: { code: 'INVALID_ARGUMENT', message: 'Nothing to redo.', recoverable: true } };
      return this.travel(entry, 'redo');
    });
  }

  /** Undo a specific history group only when it is the latest applied group. */
  undoGroup(runId: string): Promise<ApplyResult> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, revision: this.revision, error: { code: 'BUSY', message: 'Stop the AI before undoing.', recoverable: true } };
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
      const before = new Map(this.docs);
      this.activeRun = { id: runId, before, beforeState: structuredClone(this.state), startRevision: this.revision };
      await this.writeRunMarker();
      return null;
    });
  }

  /** Record exactly which files the run has changed (or is about to change), with before and after hashes. */
  private async writeRunMarker(docs: Map<string, string> = this.docs) {
    if (!this.activeRun) return;
    const paths: Record<string, { before: string | null; after: string | null }> = {};
    const all = new Set([...this.activeRun.before.keys(), ...docs.keys()]);
    for (const path of all) {
      const b = this.activeRun.before.get(path);
      const a = docs.get(path);
      if (b === a) continue;
      paths[path] = { before: b === undefined ? null : await this.putBlob(b), after: a === undefined ? null : sha(a) };
    }
    await atomicWrite(this.local('sessions', 'active-run.json'), toJson({ id: this.activeRun.id, paths }));
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
      // Verify, byte for byte, that every file the run touched still holds what the run wrote.
      const touched = new Set([...run.before.keys(), ...this.docs.keys()].filter((p) => run.before.get(p) !== this.docs.get(p)));
      for (const p of touched) {
        const disk = await this.diskContent(p);
        if (disk !== (this.docs.get(p) ?? null)) {
          this.activeRun = null;
          this.conflicts.push({ path: p, reason: 'Changed outside SiteOrigin Builder during an AI run.' });
          await fs.rm(this.local('sessions', 'active-run.json'), { force: true });
          this.emit('history');
          return { restored: false, conflict: p };
        }
      }
      this.activeRun = null;
      if (touched.size) {
        try {
          await this.persist(run.beforeState, { label: 'Revert AI changes', history: false, source: 'system' });
        } catch (e) {
          if (!(e instanceof DiskConflictError)) throw e;
          this.conflicts.push({ path: e.path, reason: 'Changed outside SiteOrigin Builder during an AI run.' });
          await fs.rm(this.local('sessions', 'active-run.json'), { force: true });
          return { restored: false, conflict: e.path };
        }
      }
      await fs.rm(this.local('sessions', 'active-run.json'), { force: true });
      this.emit('history');
      return { restored: true };
    });
  }

  // -------------------------------------------------------------------------
  // External changes
  // -------------------------------------------------------------------------

  /** Re-read canonical documents after an external edit, accepting them only when valid. */
  async reloadFromDisk(): Promise<{ ok: boolean; message?: string }> {
    return this.serialize(async () => {
      if (this.activeRun) return { ok: false, message: 'Busy' };
      let next: ProjectState;
      try {
        next = await readState(this.dir);
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
      const errors = validateState(next).filter((d) => d.severity === 'error');
      if (errors.length) return { ok: false, message: errors.map((e) => e.message).join(' ') };
      for (const def of Object.values(next.components)) {
        if (def.kind !== 'code' || def.source === this.state.components[def.id]?.source) continue;
        const bad = (await checkSvelteSource(def.source ?? '')).filter((p) => p.severity === 'error');
        if (bad.length) return { ok: false, message: `The edited code for "${def.name}" has problems, so it was not loaded: ${bad[0].message}` };
      }
      const nextDocs = stateToDocs(next);
      let same = nextDocs.size === this.docs.size;
      if (same) for (const [p, c] of nextDocs) if (this.docs.get(p) !== c) same = false;
      const srcSame = JSON.stringify([...stateToAuthoredSources(next)]) === JSON.stringify([...stateToAuthoredSources(this.state)]);
      if (same && srcSame) return { ok: true };
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
      // A validated reload resolves earlier "changed outside" conflicts.
      this.conflicts = this.conflicts.filter((c) => !c.reason.startsWith('Changed outside'));
      await this.saveLocalState();
      this.emit('changed', { revision: this.revision, changedDocs: Object.keys(changed), changedFiles, label: 'External change', source: 'system' } satisfies SessionEvent);
      return { ok: true };
    });
  }

  async close() {
    await this.writing.catch(() => undefined);
    await this.releaseLock();
    this.removeAllListeners();
  }
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
